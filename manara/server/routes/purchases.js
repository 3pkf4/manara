const express = require('express');
const router = express.Router();
const { query, transaction } = require('../db');
const { authenticate, requireRole, checkTenantActive } = require('../middleware/auth');
const { logActivity } = require('../middleware/logger');

router.use(authenticate, checkTenantActive);

async function generatePurchaseNumber(client, tenantId) {
  return require('../lib/util').nextNumber(client, tenantId, 'PUR', 'PUR');
}

router.get('/', async (req, res, next) => {
  try {
    const { from, to, supplier_id, limit = 100 } = req.query;
    let sql = `SELECT p.*, u.full_name AS user_name, b.name AS branch_name
               FROM purchases p
               LEFT JOIN users u ON u.id = p.user_id
               LEFT JOIN branches b ON b.id = p.branch_id
               WHERE p.tenant_id = $1`;
    const params = [req.tenantId];
    let i = 2;
    if (from) { sql += ` AND p.created_at >= $${i}`; params.push(from); i++; }
    if (to) { sql += ` AND p.created_at <= $${i}::date + INTERVAL '1 day'`; params.push(to); i++; }
    if (supplier_id) { sql += ` AND p.supplier_id = $${i}`; params.push(supplier_id); i++; }
    sql += ` ORDER BY p.created_at DESC LIMIT $${i}`;
    params.push(parseInt(limit));
    const r = await query(sql, params);
    res.json({ ok: true, data: r.rows });
  } catch (e) { next(e); }
});

router.get('/:id', async (req, res, next) => {
  try {
    const inv = await query(
      'SELECT * FROM purchases WHERE id = $1 AND tenant_id = $2',
      [req.params.id, req.tenantId]
    );
    if (!inv.rows.length) return res.status(404).json({ ok: false, error: 'الفاتورة غير موجودة' });
    const items = await query('SELECT * FROM purchase_items WHERE purchase_id = $1', [req.params.id]);
    res.json({ ok: true, data: { ...inv.rows[0], items: items.rows } });
  } catch (e) { next(e); }
});

// إنشاء فاتورة شراء
router.post('/', requireRole('owner', 'tenant_admin', 'branch_manager', 'warehouse'), async (req, res, next) => {
  try {
    const { supplier_id, items, paid = 0, payment_type = 'cash', notes } = req.body;
    if (!items || !Array.isArray(items) || items.length === 0)
      return res.status(400).json({ ok: false, error: 'الفاتورة فارغة' });

    const result = await transaction(async (client) => {
      let branchId = req.branchId;
      if (!branchId) {
        const m = await client.query('SELECT id FROM branches WHERE tenant_id = $1 AND is_main = TRUE LIMIT 1', [req.tenantId]);
        branchId = m.rows[0] && m.rows[0].id;
      }
      if (!branchId) throw new Error('لا يوجد فرع');
      let total = 0;
      let supplierName = '';
      let supplierObj = null;

      if (supplier_id) {
        const s = await client.query(
          'SELECT * FROM suppliers WHERE id = $1 AND tenant_id = $2',
          [supplier_id, req.tenantId]
        );
        if (s.rows.length) {
          supplierObj = s.rows[0];
          supplierName = s.rows[0].name;
        }
      }

      const processedItems = [];
      for (const item of items) {
        const qty = parseFloat(item.qty);
        const cost = parseFloat(item.unit_cost);
        if (!qty || qty <= 0) throw new Error('كمية غير صحيحة');
        if (!cost || cost < 0) throw new Error('تكلفة غير صحيحة');

        const prodRes = await client.query(
          'SELECT * FROM products WHERE id = $1 AND tenant_id = $2',
          [item.product_id, req.tenantId]
        );
        if (!prodRes.rows.length) throw new Error('المنتج غير موجود');
        const product = prodRes.rows[0];

        const lineTotal = qty * cost;
        total += lineTotal;

        processedItems.push({
          product_id: product.id,
          product_name: product.name,
          quantity: qty,
          unit_cost: cost,
          total: lineTotal,
          stock_before: parseFloat(product.stock),
          is_service: product.is_service
        });
      }

      const paidAmt = Math.min(Math.max(parseFloat(paid) || 0, 0), total);
      const remaining = total - paidAmt;
      const purchaseNumber = await generatePurchaseNumber(client, req.tenantId);

      const purRes = await client.query(
        `INSERT INTO purchases (
          tenant_id, branch_id, supplier_id, user_id, purchase_number, supplier_name,
          subtotal, total, paid, remaining, payment_type, notes, synced_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,NOW())
        RETURNING *`,
        [req.tenantId, branchId, supplier_id || null, req.user.id,
         purchaseNumber, supplierName, total, total, paidAmt, remaining, payment_type, notes || null]
      );
      const purchase = purRes.rows[0];

      // إدخال البنود + إضافة المخزون
      for (const item of processedItems) {
        await client.query(
          `INSERT INTO purchase_items (purchase_id, product_id, product_name, quantity, unit_cost, total)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [purchase.id, item.product_id, item.product_name, item.quantity, item.unit_cost, item.total]
        );

        if (!item.is_service) {
          const st = await client.query(
            'UPDATE products SET stock = stock + $1, cost_price = $2, updated_at = NOW() WHERE id = $3 RETURNING stock',
            [item.quantity, item.unit_cost, item.product_id]);
          const newStock = parseFloat(st.rows[0].stock);
          item.stock_before = newStock - item.quantity;

          await client.query(
            `INSERT INTO stock_movements (
              tenant_id, branch_id, product_id, user_id,
              movement_type, quantity, stock_before, stock_after,
              reference_id, reference_type
            ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
            [req.tenantId, branchId, item.product_id, req.user.id,
             'purchase', item.quantity, item.stock_before, newStock, purchase.id, 'purchase']
          );
        }
      }

      // تحديث رصيد المورد
      if (supplierObj && remaining > 0) {
        await client.query(
          'UPDATE suppliers SET balance = balance + $1 WHERE id = $2',
          [remaining, supplierObj.id]
        );
      }

      // خصم من الخزينة (إذا مدفوع نقدي)
      if (paidAmt > 0 && payment_type === 'cash') {
        const bal = await client.query(
          'UPDATE branches SET cash_balance = cash_balance - $1 WHERE id = $2 RETURNING cash_balance',
          [paidAmt, branchId]
        );
        const cashAfter = parseFloat(bal.rows[0].cash_balance);
        await client.query(
          `INSERT INTO cash_transactions (
            tenant_id, branch_id, user_id, transaction_type, amount,
            balance_before, balance_after, reference_id, reference_type, description
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
          [req.tenantId, branchId, req.user.id, 'purchase', -paidAmt,
           cashAfter + paidAmt, cashAfter, purchase.id, 'purchase', `شراء ${purchaseNumber}`]
        );
      }

      return purchase;
    });

    await logActivity(req, 'create_purchase', 'purchase', result.id,
      { purchase_number: result.purchase_number });
    res.json({ ok: true, data: result });
  } catch (e) {
    console.error('Purchase error:', e.message);
    res.status(e.status || 400).json({ ok: false, error: e.code === '23514' ? 'قيمة مخالفة لقيود النظام' : (e.expose || !e.code ? e.message : 'تعذر حفظ فاتورة الشراء') });
  }
});

module.exports = router;
