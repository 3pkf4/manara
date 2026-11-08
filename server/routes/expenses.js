const express = require('express');
const router = express.Router();
const { query, transaction } = require('../db');
const { authenticate, requireRole, checkTenantActive, requireTenant } = require('../middleware/auth');
const { HttpError, num, round2 } = require('../lib/util');
const { logActivity } = require('../middleware/logger');
const { validateRequired } = require('../middleware/errors');

router.use(authenticate, checkTenantActive, requireTenant);
const isUuid = (v) => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// جلب المصروفات
router.get('/', async (req, res, next) => {
  try {
    const { from, to, category, limit = 200 } = req.query;
    let sql = `SELECT e.*, u.full_name AS user_name, b.name AS branch_name
               FROM expenses e
               LEFT JOIN users u ON u.id = e.user_id
               LEFT JOIN branches b ON b.id = e.branch_id
               WHERE e.tenant_id = $1`;
    const params = [req.tenantId];
    let i = 2;
    if (from) { sql += ` AND e.expense_date >= $${i}`; params.push(from); i++; }
    if (to) { sql += ` AND e.expense_date <= $${i}`; params.push(to); i++; }
    if (category) { sql += ` AND e.category = $${i}`; params.push(category); i++; }
    sql += ` ORDER BY e.expense_date DESC, e.created_at DESC LIMIT $${i}`;
    params.push(parseInt(limit));
    const r = await query(sql, params);
    res.json({ ok: true, data: r.rows });
  } catch (e) { next(e); }
});

// إحصائيات المصروفات
router.get('/stats', async (req, res, next) => {
  try {
    const today = await query(
      `SELECT COALESCE(SUM(amount), 0) AS total FROM expenses 
       WHERE tenant_id = $1 AND expense_date = CURRENT_DATE`,
      [req.tenantId]
    );
    const month = await query(
      `SELECT COALESCE(SUM(amount), 0) AS total FROM expenses 
       WHERE tenant_id = $1 AND DATE_TRUNC('month', expense_date) = DATE_TRUNC('month', CURRENT_DATE)`,
      [req.tenantId]
    );
    const byCategory = await query(
      `SELECT category, COALESCE(SUM(amount), 0) AS total
       FROM expenses
       WHERE tenant_id = $1 AND DATE_TRUNC('month', expense_date) = DATE_TRUNC('month', CURRENT_DATE)
       GROUP BY category ORDER BY total DESC`,
      [req.tenantId]
    );
    res.json({
      ok: true,
      data: {
        today: parseFloat(today.rows[0].total),
        month: parseFloat(month.rows[0].total),
        by_category: byCategory.rows
      }
    });
  } catch (e) { next(e); }
});

async function resolveBranch(req, client) {
  if (req.branchId) return req.branchId;
  const m = await client.query('SELECT id FROM branches WHERE tenant_id = $1 AND is_main = TRUE LIMIT 1', [req.tenantId]);
  if (!m.rows.length) throw new HttpError(400, 'لا يوجد فرع');
  return m.rows[0].id;
}

async function moveCash(client, req, branchId, delta, type, refId, desc) {
  if (!delta) return;
  const bal = await client.query(
    'UPDATE branches SET cash_balance = cash_balance + $1 WHERE id = $2 AND tenant_id = $3 RETURNING cash_balance',
    [delta, branchId, req.tenantId]);
  const after = parseFloat(bal.rows[0].cash_balance);
  await client.query(
    `INSERT INTO cash_transactions (tenant_id, branch_id, user_id, transaction_type, amount,
                                    balance_before, balance_after, reference_id, reference_type, description)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'expense',$9)`,
    [req.tenantId, branchId, req.user.id, type, delta, round2(after - delta), after, refId, desc]);
}

// إضافة مصروف (يخصم من الخزينة داخل transaction واحدة)
router.post('/', async (req, res, next) => {
  try {
    const b = req.body || {};
    const amt = round2(num(b.amount, { name: 'المبلغ', min: 0.01, max: 1e9 }));
    const date = b.expense_date || (await query(`SELECT to_char(NOW(), 'YYYY-MM-DD') AS d`)).rows[0].d;
    if (!DATE_RE.test(date)) throw new HttpError(400, 'صيغة التاريخ YYYY-MM-DD');

    const row = await transaction(async (client) => {
      const branchId = await resolveBranch(req, client);
      const r = await client.query(
        `INSERT INTO expenses (tenant_id, branch_id, user_id, amount, category, description, expense_date)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
        [req.tenantId, branchId, req.user.id, amt, String(b.category || 'عام').slice(0, 100),
         b.description ? String(b.description).slice(0, 500) : null, date]);
      await moveCash(client, req, branchId, -amt, 'expense', r.rows[0].id, b.description || b.category || 'مصروف');
      return r.rows[0];
    });
    await logActivity(req, 'create_expense', 'expense', row.id, { amount: amt });
    res.json({ ok: true, data: row });
  } catch (e) { next(e); }
});

// تعديل مصروف (مدراء فقط) — الفرق في المبلغ ينعكس على الخزينة
router.put('/:id', requireRole('owner', 'tenant_admin', 'branch_manager', 'accountant'), async (req, res, next) => {
  try {
    if (!isUuid(req.params.id)) throw new HttpError(404, 'غير موجود');
    const b = req.body || {};
    const row = await transaction(async (client) => {
      const cur = await client.query('SELECT * FROM expenses WHERE id = $1 AND tenant_id = $2 FOR UPDATE', [req.params.id, req.tenantId]);
      if (!cur.rows.length) throw new HttpError(404, 'غير موجود');
      const old = cur.rows[0];
      if (req.user.role === 'branch_manager' && old.branch_id !== req.branchId) throw new HttpError(403, 'مصروف فرع آخر');

      const newAmt = b.amount !== undefined ? round2(num(b.amount, { name: 'المبلغ', min: 0.01, max: 1e9 })) : parseFloat(old.amount);
      const category = b.category !== undefined ? String(b.category).slice(0, 100) : old.category;
      const desc = b.description !== undefined ? String(b.description).slice(0, 500) : old.description;
      const date = b.expense_date !== undefined ? b.expense_date : old.expense_date;
      if (b.expense_date !== undefined && !DATE_RE.test(date)) throw new HttpError(400, 'صيغة التاريخ YYYY-MM-DD');

      const r = await client.query(
        'UPDATE expenses SET amount = $3, category = $4, description = $5, expense_date = $6 WHERE id = $1 AND tenant_id = $2 RETURNING *',
        [req.params.id, req.tenantId, newAmt, category, desc, date]);
      await moveCash(client, req, old.branch_id, -(newAmt - parseFloat(old.amount)), 'expense_adjust', old.id, 'تعديل مصروف');
      return r.rows[0];
    });
    await logActivity(req, 'update_expense', 'expense', req.params.id);
    res.json({ ok: true, data: row });
  } catch (e) { next(e); }
});

// حذف مصروف (مدراء فقط) — يُعاد المبلغ لخزينة الفرع الذي سُجّل فيه المصروف
router.delete('/:id', requireRole('owner', 'tenant_admin', 'branch_manager', 'accountant'), async (req, res, next) => {
  try {
    if (!isUuid(req.params.id)) throw new HttpError(404, 'غير موجود');
    await transaction(async (client) => {
      const cur = await client.query('SELECT * FROM expenses WHERE id = $1 AND tenant_id = $2 FOR UPDATE', [req.params.id, req.tenantId]);
      if (!cur.rows.length) throw new HttpError(404, 'غير موجود');
      const old = cur.rows[0];
      if (req.user.role === 'branch_manager' && old.branch_id !== req.branchId) throw new HttpError(403, 'مصروف فرع آخر');
      await client.query('DELETE FROM expenses WHERE id = $1 AND tenant_id = $2', [old.id, req.tenantId]);
      await moveCash(client, req, old.branch_id, parseFloat(old.amount), 'expense_refund', old.id, 'حذف مصروف');
    });
    await logActivity(req, 'delete_expense', 'expense', req.params.id);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

module.exports = router;
