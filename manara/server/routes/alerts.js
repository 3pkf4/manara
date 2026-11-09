/** تنبيهات: مخزون منخفض، قرب انتهاء الصلاحية، ديون متأخرة، ورديات مفتوحة طويلاً */
const express = require('express');
const router = express.Router();
const { query } = require('../db');
const { authenticate, checkTenantActive, requireTenant } = require('../middleware/auth');
const { getBranchFilter } = require('../middleware/branch-filter');
const { num } = require('../lib/util');

router.use(authenticate, checkTenantActive, requireTenant);

router.get('/', async (req, res, next) => {
  try {
    const expiryDays = Math.floor(num(req.query.expiry_days, { name: 'أيام الصلاحية', min: 1, max: 365, def: 30 }));
    const debtDays = Math.floor(num(req.query.debt_days, { name: 'أيام الدين', min: 1, max: 3650, def: 30 }));
    const bf = getBranchFilter(req);
    const params = [req.tenantId];
    let pb = '';
    if (bf.filter && bf.branchId) { params.push(bf.branchId); pb = ' AND branch_id = $2'; }

    const low = await query(
      `SELECT id, name, barcode, stock, min_stock, unit FROM products
        WHERE tenant_id = $1 AND is_active AND is_service = FALSE AND stock <= min_stock ${pb}
        ORDER BY (stock - min_stock) ASC LIMIT 100`, params);

    const expiring = await query(
      `SELECT id, name, barcode, stock, expiry_date, (expiry_date - CURRENT_DATE) AS days_left FROM products
        WHERE tenant_id = $1 AND is_active AND expiry_date IS NOT NULL AND stock > 0
          AND expiry_date <= CURRENT_DATE + ($${params.length + 1}::int * INTERVAL '1 day') ${pb}
        ORDER BY expiry_date ASC LIMIT 100`, [...params, expiryDays]);

    const debts = await query(
      `SELECT c.id, c.name, c.phone, c.balance,
              (SELECT MIN(i.created_at) FROM invoices i
                WHERE i.customer_id = c.id AND i.status = 'completed' AND i.remaining > 0) AS oldest_unpaid
         FROM customers c
        WHERE c.tenant_id = $1 AND c.is_active AND c.balance > 0 ${pb.replace('branch_id', 'c.branch_id')}
        ORDER BY c.balance DESC LIMIT 100`, params);
    const overdue = debts.rows.filter(d => d.oldest_unpaid &&
      (Date.now() - new Date(d.oldest_unpaid).getTime()) / 86400000 >= debtDays);

    const staleShifts = await query(
      `SELECT s.id, s.opened_at, u.full_name AS user_name FROM shifts s LEFT JOIN users u ON u.id = s.user_id
        WHERE s.tenant_id = $1 AND s.status = 'open' AND s.opened_at < NOW() - INTERVAL '16 hours'`, [req.tenantId]);

    res.json({
      ok: true,
      data: {
        low_stock: low.rows,
        expiring: expiring.rows,
        overdue_debts: overdue,
        stale_shifts: staleShifts.rows,
        counts: {
          low_stock: low.rows.length, expiring: expiring.rows.length,
          overdue_debts: overdue.length, stale_shifts: staleShifts.rows.length
        }
      }
    });
  } catch (e) { next(e); }
});

module.exports = router;
