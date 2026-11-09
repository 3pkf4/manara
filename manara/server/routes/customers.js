const express = require('express');
const router = express.Router();
const { query, transaction } = require('../db');
const { authenticate, requireRole, checkTenantActive, requireTenant } = require('../middleware/auth');
const { HttpError, num, round2, getSettings, truthy } = require('../lib/util');
const { logActivity } = require('../middleware/logger');
const { validateRequired } = require('../middleware/errors');
const { getBranchFilter, resolveBranchForInsert } = require('../middleware/branch-filter');

router.use(authenticate, checkTenantActive, requireTenant);
const isUuid = (v) => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);

router.get('/', async (req, res, next) => {
  try {
    const { search, has_debt } = req.query;
    const bf = getBranchFilter(req);

    let sql = `SELECT c.*, b.name AS branch_name, b.branch_code
               FROM customers c
               LEFT JOIN branches b ON b.id = c.branch_id
               WHERE c.tenant_id = $1 AND c.is_active = TRUE`;
    const params = [req.tenantId];
    let i = 2;

    if (bf.filter && bf.branchId) {
      sql += ` AND c.branch_id = $${i}`;
      params.push(bf.branchId);
      i++;
    }

    if (search) {
      sql += ` AND (c.name ILIKE $${i} OR c.phone ILIKE $${i})`;
      params.push(`%${search}%`);
      i++;
    }
    if (has_debt === 'true') sql += ' AND c.balance > 0';
    sql += ' ORDER BY c.name ASC';

    const r = await query(sql, params);
    res.json({ ok: true, data: r.rows });
  } catch (e) { next(e); }
});

router.get('/:id', async (req, res, next) => {
  try {
    if (!isUuid(req.params.id)) return res.status(404).json({ ok: false, error: 'العميل غير موجود' });
    const r = await query(
      'SELECT * FROM customers WHERE id = $1 AND tenant_id = $2',
      [req.params.id, req.tenantId]
    );
    if (!r.rows.length) return res.status(404).json({ ok: false, error: 'العميل غير موجود' });

    const bf = getBranchFilter(req);
    if (bf.scope === 'own' && r.rows[0].branch_id !== bf.branchId) {
      return res.status(403).json({ ok: false, error: 'هذا العميل ليس في فرعك' });
    }
    res.json({ ok: true, data: r.rows[0] });
  } catch (e) { next(e); }
});

router.post('/', async (req, res, next) => {
  try {
    const b = req.body;
    validateRequired(b, ['name']);

    const branchId = await resolveBranchForInsert(req, query);
    if (!branchId) return res.status(400).json({ ok: false, error: 'يجب تحديد الفرع' });

    const r = await query(
      `INSERT INTO customers (tenant_id, branch_id, name, phone, email, address, tax_number, credit_limit)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [req.tenantId, branchId, b.name, b.phone || null, b.email || null,
       b.address || null, b.tax_number || null, num(b.credit_limit, { name: 'سقف الدين', min: 0, max: 1e9, def: 0 })]
    );
    await logActivity(req, 'create_customer', 'customer', r.rows[0].id, { name: b.name });
    res.json({ ok: true, data: r.rows[0] });
  } catch (e) { next(e); }
});

router.put('/:id', async (req, res, next) => {
  try {
    const b = req.body || {};
    if (!isUuid(req.params.id)) return res.status(404).json({ ok: false, error: 'العميل غير موجود' });
    if (b.credit_limit !== undefined) b.credit_limit = num(b.credit_limit, { name: 'سقف الدين', min: 0, max: 1e9 });
    const fields = [];
    const params = [req.params.id, req.tenantId];
    let i = 3;
    ['name', 'phone', 'email', 'address', 'tax_number', 'credit_limit', 'notes'].forEach(f => {
      if (b[f] !== undefined) { fields.push(`${f} = $${i}`); params.push(b[f]); i++; }
    });
    if (!fields.length) return res.status(400).json({ ok: false, error: 'لا توجد بيانات' });

    const r = await query(
      `UPDATE customers SET ${fields.join(', ')} WHERE id = $1 AND tenant_id = $2 RETURNING *`,
      params
    );
    if (!r.rows.length) return res.status(404).json({ ok: false, error: 'العميل غير موجود' });
    res.json({ ok: true, data: r.rows[0] });
  } catch (e) { next(e); }
});

router.delete('/:id', async (req, res, next) => {
  try {
    const check = await query(
      'SELECT COUNT(*) FROM invoices WHERE customer_id = $1',
      [req.params.id]
    );
    if (parseInt(check.rows[0].count) > 0) {
      await query('UPDATE customers SET is_active = FALSE WHERE id = $1', [req.params.id]);
      return res.json({ ok: true, message: 'تم إلغاء التنشيط' });
    }
    await query('DELETE FROM customers WHERE id = $1 AND tenant_id = $2',
      [req.params.id, req.tenantId]);
    res.json({ ok: true });
  } catch (e) { next(e); }
});


// ============================================
// 💰 تحصيل دين من عميل (يُسجَّل في سجل مستقل + الخزينة إن كان نقداً)
// ============================================
router.post(['/:id/payments', '/:id/payment'], async (req, res, next) => {
  try {
    if (!isUuid(req.params.id)) throw new HttpError(404, 'العميل غير موجود');
    const b = req.body || {};
    const amount = round2(num(b.amount, { name: 'المبلغ', min: 0.01, max: 1e9 }));
    const method = b.method === undefined ? 'cash' : b.method;
    if (!['cash', 'card', 'transfer'].includes(method)) throw new HttpError(400, 'طريقة الدفع غير صالحة');
    const notes = b.notes ? String(b.notes).slice(0, 300) : null;

    const out = await transaction(async (client) => {
      const c = await client.query('SELECT * FROM customers WHERE id = $1 AND tenant_id = $2 FOR UPDATE', [req.params.id, req.tenantId]);
      if (!c.rows.length) throw new HttpError(404, 'العميل غير موجود');
      const cust = c.rows[0];
      const before = parseFloat(cust.balance);
      if (before <= 0) throw new HttpError(400, 'لا يوجد دين على هذا العميل');
      if (amount > before + 0.009) throw new HttpError(400, `المبلغ أكبر من الدين الحالي (${before})`, 'OVERPAY');

      let branchId = req.branchId;
      if (!branchId) {
        const m = await client.query('SELECT id FROM branches WHERE tenant_id = $1 AND is_main = TRUE LIMIT 1', [req.tenantId]);
        branchId = m.rows[0] && m.rows[0].id;
      }
      if (!branchId) throw new HttpError(400, 'لا يوجد فرع');

      const after = round2(before - amount);
      await client.query('UPDATE customers SET balance = $1, updated_at = NOW() WHERE id = $2', [after, cust.id]);
      const p = await client.query(
        `INSERT INTO customer_payments (tenant_id, branch_id, customer_id, user_id, amount, method, balance_before, balance_after, notes)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
        [req.tenantId, branchId, cust.id, req.user.id, amount, method, before, after, notes]);

      if (method === 'cash') {
        const bal = await client.query(
          'UPDATE branches SET cash_balance = cash_balance + $1 WHERE id = $2 RETURNING cash_balance', [amount, branchId]);
        const cashAfter = parseFloat(bal.rows[0].cash_balance);
        await client.query(
          `INSERT INTO cash_transactions (tenant_id, branch_id, user_id, transaction_type, amount,
                                          balance_before, balance_after, reference_id, reference_type, description)
           VALUES ($1,$2,$3,'customer_payment',$4,$5,$6,$7,'customer_payment',$8)`,
          [req.tenantId, branchId, req.user.id, amount, round2(cashAfter - amount), cashAfter, p.rows[0].id,
           `تحصيل من ${cust.name}`]);
      }
      return p.rows[0];
    });
    await logActivity(req, 'customer_payment', 'customer', req.params.id, { amount });
    res.json({ ok: true, data: out });
  } catch (e) { next(e); }
});

// ============================================
// 📄 كشف حساب عميل (فواتير + دفعات + مرتجعات برصيد تراكمي)
// ============================================
router.get('/:id/statement', async (req, res, next) => {
  try {
    if (!isUuid(req.params.id)) throw new HttpError(404, 'العميل غير موجود');
    const c = await query('SELECT id, name, phone, balance, points, branch_id FROM customers WHERE id = $1 AND tenant_id = $2', [req.params.id, req.tenantId]);
    if (!c.rows.length) throw new HttpError(404, 'العميل غير موجود');
    const bf = getBranchFilter(req);
    if (bf.scope === 'own' && c.rows[0].branch_id !== bf.branchId) throw new HttpError(403, 'هذا العميل ليس في فرعك');

    const rows = await query(
      `SELECT 'invoice' AS kind, created_at, invoice_number AS ref, remaining AS debit, 0::numeric AS credit
         FROM invoices WHERE customer_id = $1 AND tenant_id = $2 AND status = 'completed'
       UNION ALL
       SELECT 'payment', created_at, COALESCE(notes, 'تحصيل'), 0, amount
         FROM customer_payments WHERE customer_id = $1 AND tenant_id = $2
       UNION ALL
       SELECT 'return', created_at, return_number, 0, total_refund
         FROM returns WHERE customer_id = $1 AND tenant_id = $2 AND refund_method = 'credit'
       ORDER BY created_at ASC`, [req.params.id, req.tenantId]);
    let running = 0;
    const lines = rows.rows.map(r => {
      running = round2(running + parseFloat(r.debit) - parseFloat(r.credit));
      return { kind: r.kind, date: r.created_at, ref: r.ref, debit: parseFloat(r.debit), credit: parseFloat(r.credit), running };
    });
    res.json({ ok: true, data: { customer: c.rows[0], lines, computed_balance: running } });
  } catch (e) { next(e); }
});

// ============================================
// ⭐ نقاط الولاء: عرض الإعدادات + رصيد العميل
// ============================================
router.get('/:id/loyalty', async (req, res, next) => {
  try {
    if (!isUuid(req.params.id)) throw new HttpError(404, 'العميل غير موجود');
    const c = await query('SELECT id, name, points FROM customers WHERE id = $1 AND tenant_id = $2', [req.params.id, req.tenantId]);
    if (!c.rows.length) throw new HttpError(404, 'العميل غير موجود');
    const st = await getSettings({ query }, req.tenantId);
    const value = parseFloat(st.loyalty_redeem_value) || 0.1;
    res.json({ ok: true, data: {
      enabled: truthy(st.loyalty_enabled), points: c.rows[0].points,
      redeem_value: value, worth: round2(c.rows[0].points * value),
      spend_per_point: parseFloat(st.loyalty_spend_per_point) || 10
    } });
  } catch (e) { next(e); }
});

module.exports = router;
