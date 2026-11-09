/**
 * الورديات (إغلاق الصندوق): فتح وردية بمبلغ افتتاحي، ثم إغلاقها بعدّ النقد الفعلي
 * ومقارنته بالمتوقع من حركات الخزينة، مع ملخص المبيعات حسب طريقة الدفع.
 */
const express = require('express');
const router = express.Router();
const { query, transaction } = require('../db');
const { authenticate, requireRole, checkTenantActive, requireTenant } = require('../middleware/auth');
const { logActivity } = require('../middleware/logger');
const { HttpError, num, round2 } = require('../lib/util');

router.use(authenticate, checkTenantActive, requireTenant);
const isUuid = (v) => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);

/** يحسب ملخص وردية (مفتوحة أو مغلقة) حتى لحظة `until` */
async function computeSummary(client, shift, until) {
  const end = until || new Date();
  const sales = await client.query(
    `SELECT payment_type, COUNT(*) AS invoices, COALESCE(SUM(total),0) AS total,
            COALESCE(SUM(paid),0) AS paid, COALESCE(SUM(remaining),0) AS credit
       FROM invoices
      WHERE shift_id = $1 AND status = 'completed'
      GROUP BY payment_type`, [shift.id]);
  const cancelled = await client.query(
    `SELECT COUNT(*) AS n, COALESCE(SUM(total),0) AS total FROM invoices WHERE shift_id = $1 AND status = 'cancelled'`, [shift.id]);
  const cash = await client.query(
    `SELECT transaction_type, COALESCE(SUM(amount),0) AS amount, COUNT(*) AS n
       FROM cash_transactions
      WHERE branch_id = $1 AND user_id = $2 AND created_at >= $3 AND created_at <= $4
      GROUP BY transaction_type`,
    [shift.branch_id, shift.user_id, shift.opened_at, end]);
  const byType = {};
  let net = 0;
  for (const r of cash.rows) { byType[r.transaction_type] = round2(parseFloat(r.amount)); net += parseFloat(r.amount); }
  const totalSales = sales.rows.reduce((a, r) => a + parseFloat(r.total), 0);
  return {
    sales_by_payment: sales.rows.map(r => ({
      payment_type: r.payment_type, invoices: parseInt(r.invoices),
      total: round2(parseFloat(r.total)), paid: round2(parseFloat(r.paid)), credit: round2(parseFloat(r.credit))
    })),
    total_sales: round2(totalSales),
    invoices_count: sales.rows.reduce((a, r) => a + parseInt(r.invoices), 0),
    cancelled: { count: parseInt(cancelled.rows[0].n), total: round2(parseFloat(cancelled.rows[0].total)) },
    cash_movements: byType,
    cash_net: round2(net),
    expected_cash: round2(parseFloat(shift.opening_cash) + net)
  };
}

// الوردية المفتوحة الحالية (مع الملخص الحي)
router.get('/current', async (req, res, next) => {
  try {
    const r = await query("SELECT * FROM shifts WHERE user_id = $1 AND status = 'open'", [req.user.id]);
    if (!r.rows.length) return res.json({ ok: true, data: null });
    const summary = await computeSummary({ query }, r.rows[0]);
    res.json({ ok: true, data: { ...r.rows[0], live: summary } });
  } catch (e) { next(e); }
});

router.post('/open', async (req, res, next) => {
  try {
    const opening = round2(num((req.body || {}).opening_cash, { name: 'الرصيد الافتتاحي', min: 0, max: 1e9, def: 0 }));
    let branchId = req.branchId;
    if (!branchId) {
      const m = await query('SELECT id FROM branches WHERE tenant_id = $1 AND is_main = TRUE LIMIT 1', [req.tenantId]);
      branchId = m.rows[0] && m.rows[0].id;
    }
    if (!branchId) throw new HttpError(400, 'لا يوجد فرع');
    const r = await query(
      `INSERT INTO shifts (tenant_id, branch_id, user_id, opening_cash) VALUES ($1,$2,$3,$4) RETURNING *`,
      [req.tenantId, branchId, req.user.id, opening]);
    await logActivity(req, 'open_shift', 'shift', r.rows[0].id, { opening_cash: opening });
    res.json({ ok: true, data: r.rows[0] });
  } catch (e) {
    if (e.code === '23505') return res.status(400).json({ ok: false, error: 'لديك وردية مفتوحة بالفعل', code: 'SHIFT_ALREADY_OPEN' });
    next(e);
  }
});

router.post('/close', async (req, res, next) => {
  try {
    const counted = round2(num((req.body || {}).counted_cash, { name: 'النقد المعدود', min: 0, max: 1e9 }));
    const notes = (req.body || {}).notes ? String(req.body.notes).slice(0, 500) : null;

    const out = await transaction(async (client) => {
      const s = await client.query(
        "SELECT * FROM shifts WHERE user_id = $1 AND status = 'open' FOR UPDATE", [req.user.id]);
      if (!s.rows.length) throw new HttpError(400, 'لا توجد وردية مفتوحة');
      const shift = s.rows[0];
      const closedAt = new Date();
      const summary = await computeSummary(client, shift, closedAt);
      const diff = round2(counted - summary.expected_cash);
      const upd = await client.query(
        `UPDATE shifts SET status = 'closed', closed_at = $2, expected_cash = $3, counted_cash = $4,
                difference = $5, summary = $6, notes = $7
          WHERE id = $1 RETURNING *`,
        [shift.id, closedAt, summary.expected_cash, counted, diff, JSON.stringify(summary), notes]);
      return upd.rows[0];
    });
    await logActivity(req, 'close_shift', 'shift', out.id, { difference: out.difference });
    res.json({ ok: true, data: out });
  } catch (e) { next(e); }
});

// سجل الورديات: المدير يرى الكل (أو فرعه)، والكاشير ورديته فقط
router.get('/', async (req, res, next) => {
  try {
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit) || 50));
    const params = [req.tenantId];
    let where = 's.tenant_id = $1';
    if (['cashier', 'warehouse'].includes(req.user.role)) {
      params.push(req.user.id); where += ` AND s.user_id = $${params.length}`;
    } else if (req.user.role === 'branch_manager') {
      params.push(req.branchId); where += ` AND s.branch_id = $${params.length}`;
    }
    params.push(limit);
    const r = await query(
      `SELECT s.*, u.full_name AS user_name, b.name AS branch_name
         FROM shifts s LEFT JOIN users u ON u.id = s.user_id LEFT JOIN branches b ON b.id = s.branch_id
        WHERE ${where} ORDER BY s.opened_at DESC LIMIT $${params.length}`, params);
    res.json({ ok: true, data: r.rows });
  } catch (e) { next(e); }
});

router.get('/:id', async (req, res, next) => {
  try {
    if (!isUuid(req.params.id)) throw new HttpError(404, 'الوردية غير موجودة');
    const r = await query(
      `SELECT s.*, u.full_name AS user_name, b.name AS branch_name
         FROM shifts s LEFT JOIN users u ON u.id = s.user_id LEFT JOIN branches b ON b.id = s.branch_id
        WHERE s.id = $1 AND s.tenant_id = $2`, [req.params.id, req.tenantId]);
    if (!r.rows.length) throw new HttpError(404, 'الوردية غير موجودة');
    const sh = r.rows[0];
    if (['cashier', 'warehouse'].includes(req.user.role) && sh.user_id !== req.user.id) throw new HttpError(403, 'لا تملك الصلاحية');
    if (req.user.role === 'branch_manager' && sh.branch_id !== req.branchId) throw new HttpError(403, 'لا تملك الصلاحية');
    const live = sh.status === 'open' ? await computeSummary({ query }, sh) : sh.summary;
    res.json({ ok: true, data: { ...sh, report: live } });
  } catch (e) { next(e); }
});

// إغلاق وردية مستخدم آخر قسراً (مدير) — عند نسيان الكاشير
router.post('/:id/force-close', requireRole('owner', 'tenant_admin', 'branch_manager'), async (req, res, next) => {
  try {
    if (!isUuid(req.params.id)) throw new HttpError(404, 'الوردية غير موجودة');
    const counted = round2(num((req.body || {}).counted_cash, { name: 'النقد المعدود', min: 0, max: 1e9 }));
    const out = await transaction(async (client) => {
      const s = await client.query(
        "SELECT * FROM shifts WHERE id = $1 AND tenant_id = $2 AND status = 'open' FOR UPDATE", [req.params.id, req.tenantId]);
      if (!s.rows.length) throw new HttpError(404, 'الوردية غير موجودة أو مغلقة');
      const shift = s.rows[0];
      if (req.user.role === 'branch_manager' && shift.branch_id !== req.branchId) throw new HttpError(403, 'لا تملك الصلاحية');
      const closedAt = new Date();
      const summary = await computeSummary(client, shift, closedAt);
      const upd = await client.query(
        `UPDATE shifts SET status='closed', closed_at=$2, expected_cash=$3, counted_cash=$4, difference=$5,
                summary=$6, notes = COALESCE(notes,'') || ' [أُغلقت بواسطة المدير]'
          WHERE id=$1 RETURNING *`,
        [shift.id, closedAt, summary.expected_cash, counted, round2(counted - summary.expected_cash), JSON.stringify(summary)]);
      return upd.rows[0];
    });
    await logActivity(req, 'force_close_shift', 'shift', out.id);
    res.json({ ok: true, data: out });
  } catch (e) { next(e); }
});

module.exports = router;
