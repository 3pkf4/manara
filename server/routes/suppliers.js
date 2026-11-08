const express = require('express');
const router = express.Router();
const { query } = require('../db');
const { authenticate, checkTenantActive } = require('../middleware/auth');
const { logActivity } = require('../middleware/logger');
const { validateRequired } = require('../middleware/errors');

router.use(authenticate, checkTenantActive);

router.get('/', async (req, res, next) => {
  try {
    const { search } = req.query;
    let sql = 'SELECT * FROM suppliers WHERE tenant_id = $1 AND is_active = TRUE';
    const params = [req.tenantId];
    if (search) { sql += ' AND (name ILIKE $2 OR phone ILIKE $2)'; params.push(`%${search}%`); }
    sql += ' ORDER BY name ASC';
    const r = await query(sql, params);
    res.json({ ok: true, data: r.rows });
  } catch (e) { next(e); }
});

router.get('/:id', async (req, res, next) => {
  try {
    const r = await query('SELECT * FROM suppliers WHERE id = $1 AND tenant_id = $2',
      [req.params.id, req.tenantId]);
    if (!r.rows.length) return res.status(404).json({ ok: false, error: 'المورد غير موجود' });
    res.json({ ok: true, data: r.rows[0] });
  } catch (e) { next(e); }
});

router.post('/', async (req, res, next) => {
  try {
    const b = req.body;
    validateRequired(b, ['name']);
    const r = await query(
      `INSERT INTO suppliers (tenant_id, name, phone, email, address, tax_number, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [req.tenantId, b.name, b.phone || null, b.email || null,
       b.address || null, b.tax_number || null, b.notes || null]
    );
    await logActivity(req, 'create_supplier', 'supplier', r.rows[0].id);
    res.json({ ok: true, data: r.rows[0] });
  } catch (e) { next(e); }
});

router.put('/:id', async (req, res, next) => {
  try {
    const b = req.body;
    const fields = [];
    const params = [req.params.id, req.tenantId];
    let p = 3;
    ['name', 'phone', 'email', 'address', 'tax_number', 'notes'].forEach(f => {
      if (b[f] !== undefined) { fields.push(`${f} = $${p}`); params.push(b[f]); p++; }
    });
    if (!fields.length) return res.status(400).json({ ok: false, error: 'لا توجد بيانات' });
    const r = await query(
      `UPDATE suppliers SET ${fields.join(', ')} WHERE id = $1 AND tenant_id = $2 RETURNING *`,
      params
    );
    if (!r.rows.length) return res.status(404).json({ ok: false, error: 'المورد غير موجود' });
    await logActivity(req, 'update_supplier', 'supplier', req.params.id);
    res.json({ ok: true, data: r.rows[0] });
  } catch (e) { next(e); }
});

router.post('/:id/payment', async (req, res, next) => {
  try {
    const { HttpError, num, round2 } = require('../lib/util');
    const { transaction } = require('../db');
    const amt = round2(num(req.body && req.body.amount, { name: 'المبلغ', min: 0.01, max: 1e9 }));
    const method = (req.body && req.body.method) || 'cash';
    if (!['cash', 'card', 'transfer'].includes(method)) throw new HttpError(400, 'طريقة الدفع غير صالحة');
    const out = await transaction(async (client) => {
      const r = await client.query(
        'UPDATE suppliers SET balance = balance - $1 WHERE id = $2 AND tenant_id = $3 RETURNING *',
        [amt, req.params.id, req.tenantId]);
      if (!r.rows.length) throw new HttpError(404, 'المورد غير موجود');
      if (method === 'cash') {
        let branchId = req.branchId;
        if (!branchId) {
          const m = await client.query('SELECT id FROM branches WHERE tenant_id = $1 AND is_main = TRUE LIMIT 1', [req.tenantId]);
          branchId = m.rows[0] && m.rows[0].id;
        }
        if (branchId) {
          const bal = await client.query(
            'UPDATE branches SET cash_balance = cash_balance - $1 WHERE id = $2 AND tenant_id = $3 RETURNING cash_balance',
            [amt, branchId, req.tenantId]);
          const after = parseFloat(bal.rows[0].cash_balance);
          await client.query(
            `INSERT INTO cash_transactions (tenant_id, branch_id, user_id, transaction_type, amount,
                                            balance_before, balance_after, reference_id, reference_type, description)
             VALUES ($1,$2,$3,'supplier_payment',$4,$5,$6,$7,'supplier',$8)`,
            [req.tenantId, branchId, req.user.id, -amt, round2(after + amt), after, req.params.id, `دفعة للمورد ${r.rows[0].name}`]);
        }
      }
      return r.rows[0];
    });
    await logActivity(req, 'supplier_payment', 'supplier', req.params.id, { amount: amt });
    res.json({ ok: true, data: out });
  } catch (e) { next(e); }
});

router.delete('/:id', async (req, res, next) => {
  try {
    const check = await query('SELECT COUNT(*) FROM purchases WHERE supplier_id = $1', [req.params.id]);
    if (parseInt(check.rows[0].count) > 0) {
      await query('UPDATE suppliers SET is_active = FALSE WHERE id = $1 AND tenant_id = $2',
        [req.params.id, req.tenantId]);
      return res.json({ ok: true, message: 'تم إلغاء تنشيط المورد' });
    }
    await query('DELETE FROM suppliers WHERE id = $1 AND tenant_id = $2',
      [req.params.id, req.tenantId]);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

module.exports = router;
