const express = require('express');
const router = express.Router();
const { query } = require('../db');
const { authenticate, checkTenantActive } = require('../middleware/auth');

router.use(authenticate, checkTenantActive);

// ============================================
// لوحة التحكم - ملخص اليوم
// ============================================
router.get('/dashboard', async (req, res, next) => {
  try {
    const today = await query(
      `SELECT 
         COUNT(*) AS invoice_count,
         COALESCE(SUM(total), 0) AS total_sales,
         COALESCE(SUM(profit), 0) AS total_profit,
         COALESCE(SUM(paid), 0) AS total_paid,
         COALESCE(SUM(remaining), 0) AS total_remaining
       FROM invoices 
       WHERE tenant_id = $1 AND status = 'completed' AND created_at >= CURRENT_DATE`,
      [req.tenantId]
    );

    const month = await query(
      `SELECT 
         COUNT(*) AS invoice_count,
         COALESCE(SUM(total), 0) AS total_sales,
         COALESCE(SUM(profit), 0) AS total_profit
       FROM invoices 
       WHERE tenant_id = $1 AND status = 'completed' 
         AND DATE_TRUNC('month', created_at) = DATE_TRUNC('month', CURRENT_DATE)`,
      [req.tenantId]
    );

    const customers = await query(
      `SELECT 
         COALESCE(SUM(balance), 0) AS total_debt,
         COUNT(*) FILTER (WHERE balance > 0) AS debt_count
       FROM customers WHERE tenant_id = $1 AND is_active = TRUE`,
      [req.tenantId]
    );

    const lowStock = await query(
      `SELECT COUNT(*) AS count FROM products 
       WHERE tenant_id = $1 AND is_active = TRUE AND is_service = FALSE
         AND stock <= min_stock`,
      [req.tenantId]
    );

    const stockValue = await query(
      `SELECT 
         COALESCE(SUM(stock * cost_price), 0) AS cost_value,
         COALESCE(SUM(stock * sell_price), 0) AS retail_value
       FROM products WHERE tenant_id = $1 AND is_active = TRUE AND is_service = FALSE`,
      [req.tenantId]
    );

    const cash = await query(
      `SELECT COALESCE(SUM(cash_balance), 0) AS total FROM branches 
       WHERE tenant_id = $1 AND is_active = TRUE`,
      [req.tenantId]
    );

    const expensesMonth = await query(
      `SELECT COALESCE(SUM(amount), 0) AS total FROM expenses 
       WHERE tenant_id = $1 AND DATE_TRUNC('month', expense_date) = DATE_TRUNC('month', CURRENT_DATE)`,
      [req.tenantId]
    );

    res.json({
      ok: true,
      data: {
        today: {
          sales: parseFloat(today.rows[0].total_sales),
          profit: parseFloat(today.rows[0].total_profit),
          paid: parseFloat(today.rows[0].total_paid),
          invoices: parseInt(today.rows[0].invoice_count)
        },
        month: {
          sales: parseFloat(month.rows[0].total_sales),
          profit: parseFloat(month.rows[0].total_profit),
          invoices: parseInt(month.rows[0].invoice_count)
        },
        customer_debts: parseFloat(customers.rows[0].total_debt),
        debt_count: parseInt(customers.rows[0].debt_count),
        low_stock_count: parseInt(lowStock.rows[0].count),
        stock_value: {
          cost: parseFloat(stockValue.rows[0].cost_value),
          retail: parseFloat(stockValue.rows[0].retail_value)
        },
        cash_balance: parseFloat(cash.rows[0].total),
        expenses_month: parseFloat(expensesMonth.rows[0].total)
      }
    });
  } catch (e) { next(e); }
});

// ============================================
// مبيعات آخر 7 أيام (للرسم البياني)
// ============================================
router.get('/sales-daily', async (req, res, next) => {
  try {
    const days = parseInt(req.query.days) || 7;
    const r = await query(
      `SELECT 
         TO_CHAR(d.day, 'YYYY-MM-DD') AS date,
         TO_CHAR(d.day, 'Day') AS day_name,
         COALESCE(SUM(i.total), 0) AS sales,
         COALESCE(SUM(i.profit), 0) AS profit,
         COUNT(i.id) AS count
       FROM generate_series(
         CURRENT_DATE - INTERVAL '${days - 1} days',
         CURRENT_DATE,
         '1 day'::interval
       ) AS d(day)
       LEFT JOIN invoices i ON DATE(i.created_at) = DATE(d.day) 
         AND i.tenant_id = $1 AND i.status = 'completed'
       GROUP BY d.day
       ORDER BY d.day`,
      [req.tenantId]
    );
    res.json({ ok: true, data: r.rows.map(row => ({
      date: row.date,
      day: row.day_name.trim(),
      sales: parseFloat(row.sales),
      profit: parseFloat(row.profit),
      count: parseInt(row.count)
    })) });
  } catch (e) { next(e); }
});

// ============================================
// مبيعات آخر 12 شهر
// ============================================
router.get('/sales-monthly', async (req, res, next) => {
  try {
    const r = await query(
      `SELECT 
         TO_CHAR(DATE_TRUNC('month', created_at), 'YYYY-MM') AS month,
         COUNT(*) AS count,
         COALESCE(SUM(total), 0) AS sales,
         COALESCE(SUM(profit), 0) AS profit
       FROM invoices 
       WHERE tenant_id = $1 AND status = 'completed'
         AND created_at >= NOW() - INTERVAL '12 months'
       GROUP BY DATE_TRUNC('month', created_at)
       ORDER BY DATE_TRUNC('month', created_at)`,
      [req.tenantId]
    );
    res.json({ ok: true, data: r.rows });
  } catch (e) { next(e); }
});

// ============================================
// الأكثر مبيعاً
// ============================================
router.get('/top-products', async (req, res, next) => {
  try {
    const limit = parseInt(req.query.limit) || 10;
    const { from, to } = req.query;
    let dateFilter = '';
    const params = [req.tenantId];
    let i = 2;
    if (from) { dateFilter += ` AND i.created_at >= $${i}`; params.push(from); i++; }
    if (to) { dateFilter += ` AND i.created_at <= $${i}::date + INTERVAL '1 day'`; params.push(to); i++; }

    const r = await query(
      `SELECT 
         ii.product_id,
         ii.product_name,
         SUM(ii.quantity) AS total_qty,
         SUM(ii.total) AS total_sales,
         SUM((ii.unit_price - ii.unit_cost) * ii.quantity) AS total_profit
       FROM invoice_items ii
       JOIN invoices i ON i.id = ii.invoice_id
       WHERE i.tenant_id = $1 AND i.status = 'completed' ${dateFilter}
       GROUP BY ii.product_id, ii.product_name
       ORDER BY total_qty DESC
       LIMIT $${i}`,
      [...params, limit]
    );
    res.json({ ok: true, data: r.rows });
  } catch (e) { next(e); }
});

// ============================================
// تقرير الأرباح والخسائر (P&L)
// ============================================
router.get('/profit-loss', async (req, res, next) => {
  try {
    const { from, to } = req.query;
    const dd = (await query(`SELECT to_char(date_trunc('month', NOW()), 'YYYY-MM-DD') AS f, to_char(NOW(), 'YYYY-MM-DD') AS t`)).rows[0];
    const f = from || dd.f;   // بتوقيت قاعدة البيانات لا UTC
    const t = to || dd.t;

    const sales = await query(
      `SELECT 
         COALESCE(SUM(total), 0) AS total_sales,
         COALESCE(SUM(profit), 0) AS gross_profit,
         COUNT(*) AS invoice_count
       FROM invoices 
       WHERE tenant_id = $1 AND status = 'completed'
         AND created_at >= $2 AND created_at <= $3::date + INTERVAL '1 day'`,
      [req.tenantId, f, t]
    );

    const expenses = await query(
      `SELECT 
         category,
         COALESCE(SUM(amount), 0) AS total
       FROM expenses 
       WHERE tenant_id = $1 AND expense_date >= $2 AND expense_date <= $3
       GROUP BY category ORDER BY total DESC`,
      [req.tenantId, f, t]
    );

    const totalExpenses = expenses.rows.reduce((s, x) => s + parseFloat(x.total), 0);
    const returns = await query(
      `SELECT COALESCE(SUM(total_refund), 0) AS total FROM returns 
       WHERE tenant_id = $1 AND created_at >= $2 AND created_at <= $3::date + INTERVAL '1 day'`,
      [req.tenantId, f, t]
    );

    const grossProfit = parseFloat(sales.rows[0].gross_profit);
    const netProfit = grossProfit - totalExpenses;

    res.json({
      ok: true,
      data: {
        period: { from: f, to: t },
        revenue: parseFloat(sales.rows[0].total_sales),
        invoice_count: parseInt(sales.rows[0].invoice_count),
        gross_profit: grossProfit,
        returns: parseFloat(returns.rows[0].total),
        expenses: expenses.rows.map(x => ({ category: x.category, total: parseFloat(x.total) })),
        total_expenses: totalExpenses,
        net_profit: netProfit,
        margin_percent: sales.rows[0].total_sales > 0 
          ? (netProfit / parseFloat(sales.rows[0].total_sales) * 100).toFixed(2)
          : 0
      }
    });
  } catch (e) { next(e); }
});

// ============================================
// تقرير المخزون
// ============================================
router.get('/stock', async (req, res, next) => {
  try {
    const r = await query(
      `SELECT 
         category,
         COUNT(*) AS product_count,
         SUM(stock) AS total_qty,
         SUM(stock * cost_price) AS cost_value,
         SUM(stock * sell_price) AS retail_value
       FROM products 
       WHERE tenant_id = $1 AND is_active = TRUE AND is_service = FALSE
       GROUP BY category ORDER BY retail_value DESC`,
      [req.tenantId]
    );
    const low = await query(
      `SELECT id, name, stock, min_stock FROM products 
       WHERE tenant_id = $1 AND is_active = TRUE AND is_service = FALSE
         AND stock <= min_stock
       ORDER BY (stock - min_stock) ASC LIMIT 50`,
      [req.tenantId]
    );
    res.json({ ok: true, data: { by_category: r.rows, low_stock: low.rows } });
  } catch (e) { next(e); }
});

// ============================================
// تقرير أداء الكاشيرين
// ============================================
router.get('/cashiers', async (req, res, next) => {
  try {
    const { from, to } = req.query;
    let dateFilter = '';
    const params = [req.tenantId];
    let i = 2;
    if (from) { dateFilter += ` AND i.created_at >= $${i}`; params.push(from); i++; }
    if (to) { dateFilter += ` AND i.created_at <= $${i}::date + INTERVAL '1 day'`; params.push(to); i++; }

    const r = await query(
      `SELECT 
         u.id, u.full_name, u.username,
         COUNT(i.id) AS invoice_count,
         COALESCE(SUM(i.total), 0) AS total_sales,
         COALESCE(SUM(i.profit), 0) AS total_profit
       FROM users u
       LEFT JOIN invoices i ON i.user_id = u.id AND i.status = 'completed' ${dateFilter}
       WHERE u.tenant_id = $1 AND u.is_active = TRUE
       GROUP BY u.id, u.full_name, u.username
       ORDER BY total_sales DESC`,
      params
    );
    res.json({ ok: true, data: r.rows });
  } catch (e) { next(e); }
});

module.exports = router;
