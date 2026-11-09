const express = require('express');
const router = express.Router();
const { query, transaction } = require('../db');
const { authenticate, checkTenantActive, requireTenant } = require('../middleware/auth');
const { logActivity } = require('../middleware/logger');
const { getBranchFilter } = require('../middleware/branch-filter');
const { HttpError, num, round2, round3, nextNumber } = require('../lib/util');

router.use(authenticate, checkTenantActive, requireTenant);

const MANAGER_ROLES = ['owner', 'tenant_admin', 'branch_manager', 'accountant'];
const REFUND_METHODS = ['cash', 'credit', 'card', 'transfer'];
const isUuid = (v) => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);

// جلب المرتجعات
router.get('/', async (req, res, next) => {
  try {
    const { from, to, limit = 100 } = req.query;
    let sql = `SELECT r.*, u.full_name AS user_name, b.name AS branch_name
               FROM returns r
               LEFT JOIN users u ON u.id = r.user_id
               LEFT JOIN branches b ON b.id = r.branch_id
               WHERE r.tenant_id = $1`;
    const params = [req.tenantId];
    let i = 2;
    if (from) { sql += ` AND r.created_at >= $${i}`; params.push(from); i++; }
    if (to) { sql += ` AND r.created_at <= $${i}::date + INTERVAL '1 day'`; params.push(to); i++; }
    sql += ` ORDER BY r.created_at DESC LIMIT $${i}`;
    params.push(parseInt(limit));
    const r = await query(sql, params);
    res.json({ ok: true, data: r.rows });
  } catch (e) { next(e); }
});

// جلب مرتجع واحد
router.get('/:id', async (req, res, next) => {
  try {
    const ret = await query(
      'SELECT * FROM returns WHERE id = $1 AND tenant_id = $2',
      [req.params.id, req.tenantId]
    );
    if (!ret.rows.length) return res.status(404).json({ ok: false, error: 'المرتجع غير موجود' });
    const items = await query('SELECT * FROM return_items WHERE return_id = $1', [req.params.id]);
    res.json({ ok: true, data: { ...ret.rows[0], items: items.rows } });
  } catch (e) { next(e); }
});

// جلب فاتورة للربط (للمرتجعات)
router.get('/invoice/:invoiceNumber', async (req, res, next) => {
  try {
    const inv = await query(
      `SELECT i.*, c.name AS customer_name_real
       FROM invoices i
       LEFT JOIN customers c ON c.id = i.customer_id
       WHERE i.tenant_id = $1 AND (i.invoice_number = $2 OR i.id::text = $2)
         AND i.status = 'completed'
       LIMIT 1`,
      [req.tenantId, req.params.invoiceNumber]
    );
    if (!inv.rows.length) return res.status(404).json({ ok: false, error: 'الفاتورة غير موجودة' });
    const items = await query(
      'SELECT * FROM invoice_items WHERE invoice_id = $1',
      [inv.rows[0].id]
    );
    res.json({ ok: true, data: { ...inv.rows[0], items: items.rows } });
  } catch (e) { next(e); }
});

// إنشاء مرتجع
// ============================================
// إنشاء مرتجع
//  - الكاشير: مرتجع مرتبط بفاتورة مكتملة في فرعه فقط، والسعر من الفاتورة لا من العميل
//  - المدير: يمكنه إرجاع بدون فاتورة بسعر يحدده
//  - لا يمكن إرجاع أكثر من الكمية المباعة (بعد خصم المرتجعات السابقة)
// ============================================
router.post('/', async (req, res, next) => {
  try {
    const b = req.body || {};
    const items = b.items;
    if (!Array.isArray(items) || items.length === 0) throw new HttpError(400, 'لا توجد أصناف للإرجاع');
    const method = b.refund_method === undefined ? 'cash' : b.refund_method;
    if (!REFUND_METHODS.includes(method)) throw new HttpError(400, 'طريقة الاسترداد غير صالحة');
    const isManager = MANAGER_ROLES.includes(req.user.role);
    if (!b.invoice_id && !isManager) throw new HttpError(403, 'الإرجاع بدون فاتورة للمدير فقط');
    if (b.invoice_id && !isUuid(b.invoice_id)) throw new HttpError(400, 'معرّف الفاتورة غير صالح');
    const reason = b.reason ? String(b.reason).slice(0, 300) : null;

    const result = await transaction(async (client) => {
      let invoice = null;
      let invItems = new Map();
      let alreadyReturned = new Map();
      let discountFraction = 0;

      if (b.invoice_id) {
        const iv = await client.query(
          'SELECT * FROM invoices WHERE id = $1 AND tenant_id = $2 FOR UPDATE', [b.invoice_id, req.tenantId]);
        if (!iv.rows.length) throw new HttpError(404, 'الفاتورة غير موجودة');
        invoice = iv.rows[0];
        if (invoice.status !== 'completed') throw new HttpError(400, 'لا يمكن الإرجاع على فاتورة ملغاة');
        const bf = getBranchFilter(req);
        if (bf.filter && bf.branchId && invoice.branch_id !== bf.branchId) {
          throw new HttpError(403, 'الفاتورة تابعة لفرع آخر');
        }
        const rows = await client.query('SELECT * FROM invoice_items WHERE invoice_id = $1', [invoice.id]);
        for (const r of rows.rows) {
          const cur = invItems.get(r.product_id) || { qty: 0, value: 0 };
          cur.qty += parseFloat(r.quantity);
          cur.value += parseFloat(r.quantity) * parseFloat(r.unit_price);
          invItems.set(r.product_id, cur);
        }
        const prev = await client.query(
          `SELECT ri.product_id, COALESCE(SUM(ri.quantity),0) AS qty
             FROM return_items ri JOIN returns r ON r.id = ri.return_id
            WHERE r.invoice_id = $1 GROUP BY ri.product_id`, [invoice.id]);
        for (const r of prev.rows) alreadyReturned.set(r.product_id, parseFloat(r.qty));
        const sub = parseFloat(invoice.subtotal) || 0;
        discountFraction = sub > 0 ? Math.min(1, parseFloat(invoice.discount_amount) / sub) : 0;
      }

      const branchId = invoice ? invoice.branch_id : (req.branchId || (await client.query(
        'SELECT id FROM branches WHERE tenant_id = $1 AND is_main = TRUE LIMIT 1', [req.tenantId])).rows[0]?.id);
      if (!branchId) throw new HttpError(400, 'لا يوجد فرع');

      // قفل المنتجات بترتيب ثابت
      const ids = [...new Set(items.map(it => it && it.product_id))];
      if (ids.some(id => !isUuid(id))) throw new HttpError(400, 'معرّف منتج غير صالح');
      const prodRes = await client.query(
        'SELECT * FROM products WHERE id = ANY($1::uuid[]) AND tenant_id = $2 ORDER BY id FOR UPDATE', [ids, req.tenantId]);
      const products = new Map(prodRes.rows.map(p => [p.id, p]));

      const asked = new Map();
      let total = 0;
      const lines = [];
      for (const it of items) {
        const p = products.get(it.product_id);
        if (!p) throw new HttpError(400, 'منتج غير موجود');
        const qty = round3(num(it.qty, { name: 'الكمية', min: 0.001, max: 1000000 }));
        asked.set(p.id, (asked.get(p.id) || 0) + qty);

        let unit;
        if (invoice) {
          const sold = invItems.get(p.id);
          if (!sold) throw new HttpError(400, `المنتج "${p.name}" غير موجود في الفاتورة`);
          const remainingQty = sold.qty - (alreadyReturned.get(p.id) || 0);
          if (asked.get(p.id) > remainingQty + 1e-9) {
            throw new HttpError(400, `الكمية المرتجعة من "${p.name}" تتجاوز المتاح للإرجاع (${round3(remainingQty)})`, 'RETURN_EXCEEDS_SOLD');
          }
          // السعر الفعلي المدفوع = سعر الفاتورة بعد نسبة الخصم العام
          unit = round2((sold.value / sold.qty) * (1 - discountFraction));
        } else {
          unit = round2(num(it.unit_price, { name: 'السعر', min: 0, max: 100000000 }));
        }
        const lineTotal = round2(qty * unit);
        total += lineTotal;
        lines.push({ p, qty, unit, lineTotal });
      }
      total = round2(total);

      if (method === 'credit' && !(invoice && invoice.customer_id) && !b.customer_id) {
        throw new HttpError(400, 'الاسترداد على الحساب يتطلب عميلاً');
      }
      const customerId = (invoice && invoice.customer_id) || b.customer_id || null;
      if (customerId && !isUuid(customerId)) throw new HttpError(400, 'معرّف العميل غير صالح');

      const returnNumber = await nextNumber(client, req.tenantId, 'RET', 'RET');
      const retRes = await client.query(
        `INSERT INTO returns (tenant_id, branch_id, user_id, invoice_id, return_number, customer_id,
                              total_refund, refund_method, reason)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
        [req.tenantId, branchId, req.user.id, invoice ? invoice.id : null, returnNumber, customerId,
         total, method, reason]);
      const ret = retRes.rows[0];

      for (const ln of lines) {
        await client.query(
          `INSERT INTO return_items (return_id, product_id, product_name, quantity, unit_price, refund_amount)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [ret.id, ln.p.id, ln.p.name, ln.qty, ln.unit, ln.lineTotal]);
        if (!ln.p.is_service) {
          const st = await client.query(
            'UPDATE products SET stock = stock + $1, updated_at = NOW() WHERE id = $2 RETURNING stock', [ln.qty, ln.p.id]);
          const after = parseFloat(st.rows[0].stock);
          await client.query(
            `INSERT INTO stock_movements (tenant_id, branch_id, product_id, user_id, movement_type, quantity,
                                          stock_before, stock_after, reference_id, reference_type)
             VALUES ($1,$2,$3,$4,'return',$5,$6,$7,$8,'return')`,
            [req.tenantId, branchId, ln.p.id, req.user.id, ln.qty, round3(after - ln.qty), after, ret.id]);
        }
      }

      if (method === 'cash' && total > 0) {
        const bal = await client.query(
          'UPDATE branches SET cash_balance = cash_balance - $1 WHERE id = $2 RETURNING cash_balance', [total, branchId]);
        const after = parseFloat(bal.rows[0].cash_balance);
        await client.query(
          `INSERT INTO cash_transactions (tenant_id, branch_id, user_id, transaction_type, amount,
                                          balance_before, balance_after, reference_id, reference_type, description)
           VALUES ($1,$2,$3,'refund',$4,$5,$6,$7,'return',$8)`,
          [req.tenantId, branchId, req.user.id, -total, round2(after + total), after, ret.id, `مرتجع ${returnNumber}`]);
      } else if (method === 'credit' && customerId && total > 0) {
        const c = await client.query(
          'UPDATE customers SET balance = balance - $1, updated_at = NOW() WHERE id = $2 AND tenant_id = $3 RETURNING id',
          [total, customerId, req.tenantId]);
        if (!c.rows.length) throw new HttpError(400, 'العميل غير موجود');
      }
      return ret;
    });

    await logActivity(req, 'create_return', 'return', result.id, { total: result.total });
    res.json({ ok: true, data: result });
  } catch (e) { next(e); }
});

module.exports = router;
