/**
 * تصدير CSV (يفتح في Excel بالعربية). للمديرين والمحاسبين فقط.
 * GET /api/export/:type?from=YYYY-MM-DD&to=YYYY-MM-DD   النوع: sales | products | customers | expenses | inventory
 * يستلزم رأس Authorization؛ الواجهة تنزّله عبر fetch ثم Blob.
 */
const express = require('express');
const router = express.Router();
const { query } = require('../db');
const { authenticate, requireRole, checkTenantActive, requireTenant } = require('../middleware/auth');
const { getBranchFilter } = require('../middleware/branch-filter');
const { toCsv, HttpError } = require('../lib/util');
const { logActivity } = require('../middleware/logger');

router.use(authenticate, checkTenantActive, requireTenant, requireRole('owner', 'tenant_admin', 'branch_manager', 'accountant'));

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const day = (d) => (d ? new Date(d).toISOString().slice(0, 10) : '');

const EXPORTS = {
  sales: {
    file: 'sales',
    columns: [
      { label: 'رقم الفاتورة', key: 'invoice_number' }, { label: 'التاريخ', get: r => r.created_at },
      { label: 'الفرع', key: 'branch_name' }, { label: 'الكاشير', key: 'cashier_name' },
      { label: 'العميل', key: 'customer_name' }, { label: 'الإجمالي الفرعي', key: 'subtotal' },
      { label: 'الخصم', key: 'discount_amount' }, { label: 'الإجمالي', key: 'total' },
      { label: 'المدفوع', key: 'paid' }, { label: 'المتبقي', key: 'remaining' },
      { label: 'طريقة الدفع', key: 'payment_type' }, { label: 'الربح', key: 'profit' }, { label: 'الحالة', key: 'status' }
    ],
    sql: (bf, i) => ({
      text: `SELECT i.*, u.full_name AS cashier_name, b.name AS branch_name
               FROM invoices i LEFT JOIN users u ON u.id = i.user_id LEFT JOIN branches b ON b.id = i.branch_id
              WHERE i.tenant_id = $1 ${bf ? `AND i.branch_id = $${i}` : ''}
                AND i.created_at >= $${bf ? i + 1 : i}::date AND i.created_at < $${bf ? i + 2 : i + 1}::date + INTERVAL '1 day'
              ORDER BY i.created_at`,
      dates: true
    })
  },
  products: {
    file: 'products',
    columns: [
      { label: 'الباركود', key: 'barcode' }, { label: 'الاسم', key: 'name' }, { label: 'التصنيف', key: 'category' },
      { label: 'سعر التكلفة', key: 'cost_price' }, { label: 'سعر البيع', key: 'sell_price' },
      { label: 'الكمية', key: 'stock' }, { label: 'الحد الأدنى', key: 'min_stock' },
      { label: 'الوحدة', key: 'unit' }, { label: 'تاريخ الصلاحية', get: r => day(r.expiry_date) }
    ],
    sql: (bf, i) => ({
      text: `SELECT * FROM products WHERE tenant_id = $1 AND is_active ${bf ? `AND branch_id = $${i}` : ''} ORDER BY name`
    })
  },
  inventory: {
    file: 'inventory-valuation',
    columns: [
      { label: 'المنتج', key: 'name' }, { label: 'الكمية', key: 'stock' },
      { label: 'التكلفة', key: 'cost_price' }, { label: 'قيمة المخزون بالتكلفة', get: r => (r.stock * r.cost_price).toFixed(2) },
      { label: 'سعر البيع', key: 'sell_price' }, { label: 'قيمة المخزون بالبيع', get: r => (r.stock * r.sell_price).toFixed(2) }
    ],
    sql: (bf, i) => ({
      text: `SELECT name, stock::float8 AS stock, cost_price::float8 AS cost_price, sell_price::float8 AS sell_price
               FROM products WHERE tenant_id = $1 AND is_active AND is_service = FALSE ${bf ? `AND branch_id = $${i}` : ''}
              ORDER BY name`
    })
  },
  customers: {
    file: 'customers',
    columns: [
      { label: 'الاسم', key: 'name' }, { label: 'الهاتف', key: 'phone' }, { label: 'العنوان', key: 'address' },
      { label: 'الرصيد (دين)', key: 'balance' }, { label: 'سقف الدين', key: 'credit_limit' }, { label: 'النقاط', key: 'points' }
    ],
    sql: (bf, i) => ({
      text: `SELECT * FROM customers WHERE tenant_id = $1 AND is_active ${bf ? `AND branch_id = $${i}` : ''} ORDER BY name`
    })
  },
  expenses: {
    file: 'expenses',
    columns: [
      { label: 'التاريخ', get: r => day(r.expense_date) }, { label: 'التصنيف', key: 'category' },
      { label: 'الوصف', key: 'description' }, { label: 'المبلغ', key: 'amount' }, { label: 'المستخدم', key: 'user_name' }
    ],
    sql: (bf, i) => ({
      text: `SELECT e.*, u.full_name AS user_name FROM expenses e LEFT JOIN users u ON u.id = e.user_id
              WHERE e.tenant_id = $1 ${bf ? `AND e.branch_id = $${i}` : ''}
                AND e.expense_date >= $${bf ? i + 1 : i}::date AND e.expense_date <= $${bf ? i + 2 : i + 1}::date
              ORDER BY e.expense_date`,
      dates: true
    })
  }
};

router.get('/:type', async (req, res, next) => {
  try {
    const def = EXPORTS[req.params.type];
    if (!def) throw new HttpError(404, 'نوع التصدير غير معروف. المتاح: ' + Object.keys(EXPORTS).join(', '));
    const bf = getBranchFilter(req);
    const params = [req.tenantId];
    const useBranch = bf.filter && bf.branchId;
    if (useBranch) params.push(bf.branchId);
    const q = def.sql(useBranch, params.length + 1);
    if (q.dates) {
      // التواريخ الافتراضية تُحسب بتوقيت قاعدة البيانات (وليس UTC) كي لا تضيع مبيعات ما بعد منتصف الليل محلياً
      const d = (await query(`SELECT to_char(date_trunc('month', NOW()), 'YYYY-MM-DD') AS f, to_char(NOW(), 'YYYY-MM-DD') AS t`)).rows[0];
      const from = req.query.from || d.f;
      const to = req.query.to || d.t;
      if (!DATE_RE.test(from) || !DATE_RE.test(to)) throw new HttpError(400, 'صيغة التاريخ YYYY-MM-DD');
      params.push(from, to);
    }
    const r = await query(q.text, params);
    const csv = toCsv(def.columns, r.rows);
    await logActivity(req, 'export_' + req.params.type, 'export', null, { rows: r.rows.length });
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${def.file}-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.send(csv);
  } catch (e) { next(e); }
});

module.exports = router;
