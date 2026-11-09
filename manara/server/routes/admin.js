/**
 * لوحة المالك (مالك المنظومة) + إحصائيات مدير المتجر.
 * مسارات المنصة (عملاء/اشتراكات/أكواد) للمالك فقط.
 */
const express = require('express');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const router = express.Router();
const { query, transaction } = require('../db');
const { authenticate, requireRole, checkTenantActive } = require('../middleware/auth');
const { logActivity } = require('../middleware/logger');
const { HttpError, num } = require('../lib/util');
const { checkPasswordStrength } = require('../lib/password');
const { bcryptRounds } = require('../lib/config');
const { createCodes, PLANS } = require('../lib/license');

router.use(authenticate, checkTenantActive);
const ownerOnly = requireRole('owner');
const isUuid = (v) => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
const PLAN_NAMES = ['basic', 'pro', 'enterprise'];

// ============================================
// إحصائيات: المالك = المنصة، مدير المتجر = متجره
// ============================================
router.get('/stats', requireRole('owner', 'tenant_admin'), async (req, res, next) => {
  try {
    if (req.user.role === 'owner') {
      const t = await query(`
        SELECT COUNT(*) AS total,
               COUNT(*) FILTER (WHERE is_active AND NOT is_suspended AND subscription_end > NOW()) AS active,
               COUNT(*) FILTER (WHERE is_trial) AS trials,
               COUNT(*) FILTER (WHERE subscription_end <= NOW() OR subscription_end IS NULL) AS expired,
               COUNT(*) FILTER (WHERE is_suspended) AS suspended
          FROM tenants`);
      const f = await query(`SELECT COALESCE(SUM(total),0) AS total_sales, COUNT(*) AS total_invoices
                               FROM invoices WHERE status = 'completed'`);
      const recent = await query(`SELECT id, tenant_code, business_name, owner_name, is_active, is_suspended, created_at
                                    FROM tenants ORDER BY created_at DESC LIMIT 8`);
      return res.json({ ok: true, data: { tenants: t.rows[0], financials: f.rows[0], recent_tenants: recent.rows } });
    }

    const tenantId = req.tenantId;
    const branchId = isUuid(req.query.branch_id) ? req.query.branch_id : null;
    const branchFilter = branchId ? 'AND branch_id = $2' : '';
    const params = branchId ? [tenantId, branchId] : [tenantId];
    const salesRes = await query(
      `SELECT COALESCE(SUM(total), 0) as total_sales, COALESCE(SUM(profit), 0) as total_profit, COUNT(*) as invoice_count
         FROM invoices WHERE tenant_id = $1 ${branchFilter} AND status = 'completed' AND created_at >= CURRENT_DATE`, params);
    const customersRes = await query(
      'SELECT COALESCE(SUM(balance), 0) as total_debts FROM customers WHERE tenant_id = $1 AND balance > 0', [tenantId]);
    const lowStockRes = await query(
      'SELECT COUNT(*) as low_stock FROM products WHERE tenant_id = $1 AND is_active AND is_service = FALSE AND stock <= min_stock', [tenantId]);
    res.json({
      ok: true,
      data: {
        today: {
          sales: parseFloat(salesRes.rows[0].total_sales),
          profit: parseFloat(salesRes.rows[0].total_profit),
          invoices: parseInt(salesRes.rows[0].invoice_count)
        },
        customer_debts: parseFloat(customersRes.rows[0].total_debts),
        low_stock_count: parseInt(lowStockRes.rows[0].low_stock)
      }
    });
  } catch (e) { next(e); }
});

// ============================================
// العملاء (المتاجر)
// ============================================
router.get('/tenants', ownerOnly, async (req, res, next) => {
  try {
    const params = [];
    let where = '';
    if (req.query.search) {
      params.push(`%${String(req.query.search).slice(0, 100)}%`);
      where = 'WHERE t.business_name ILIKE $1 OR t.tenant_code ILIKE $1 OR t.owner_name ILIKE $1 OR t.owner_phone ILIKE $1';
    }
    const r = await query(`
      SELECT t.id, t.tenant_code, t.business_name, t.owner_name, t.owner_phone, t.owner_email, t.plan,
             t.is_active, t.is_suspended, t.is_trial, t.subscription_end, t.subscription_status, t.created_at,
             (SELECT COUNT(*) FROM branches b WHERE b.tenant_id = t.id) AS branch_count,
             (SELECT COUNT(*) FROM users u WHERE u.tenant_id = t.id) AS user_count,
             (SELECT COUNT(*) FROM products p WHERE p.tenant_id = t.id) AS product_count,
             (SELECT COALESCE(SUM(i.total),0) FROM invoices i WHERE i.tenant_id = t.id AND i.status='completed') AS total_sales
        FROM tenants t ${where}
       ORDER BY t.created_at DESC LIMIT 500`, params);
    res.json({ ok: true, data: r.rows });
  } catch (e) { next(e); }
});

router.post('/tenants', ownerOnly, async (req, res, next) => {
  try {
    const b = req.body || {};
    for (const f of ['business_name', 'owner_name', 'owner_phone', 'admin_username', 'admin_password']) {
      if (!b[f] || typeof b[f] !== 'string') throw new HttpError(400, `الحقل ${f} مطلوب`);
    }
    if (!/^[\w.\-@]{3,50}$/.test(b.admin_username.trim())) throw new HttpError(400, 'اسم دخول المدير غير صالح');
    const weak = checkPasswordStrength(b.admin_password);
    if (weak) throw new HttpError(400, weak);
    const plan = PLAN_NAMES.includes(b.plan) ? b.plan : 'basic';
    const trialDays = num(b.trial_days, { name: 'أيام التجربة', min: 0, max: 365, def: 14 });
    const maxBranches = num(b.max_branches, { name: 'الفروع', min: 1, max: 100, def: 1 });
    const maxUsers = num(b.max_users, { name: 'المستخدمون', min: 1, max: 1000, def: 3 });
    const maxProducts = num(b.max_products, { name: 'المنتجات', min: 1, max: 1000000, def: 500 });

    const result = await transaction(async (client) => {
      const tenantId = uuidv4();
      const tenantCode = 'CLIENT' + String(Math.floor(100000 + Math.random() * 900000));
      await client.query(
        `INSERT INTO tenants (id, tenant_code, business_name, owner_name, owner_phone, owner_email, address, currency,
                              plan, is_trial, subscription_status, subscription_end,
                              max_branches, max_users, max_products, license_key, api_key)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,TRUE,'active', NOW() + ($10::int * INTERVAL '1 day'),$11,$12,$13,$14,$15)`,
        [tenantId, tenantCode, b.business_name.trim(), b.owner_name.trim(), b.owner_phone.trim(),
         b.owner_email || null, b.address || null, b.currency || 'LYD', plan, trialDays,
         maxBranches, maxUsers, maxProducts,
         'LIC-' + uuidv4().slice(0, 12).toUpperCase(), 'api_' + uuidv4().replace(/-/g, '')]
      );
      const branchId = uuidv4();
      await client.query(
        `INSERT INTO branches (id, tenant_id, branch_code, name, address, phone, is_main)
         VALUES ($1,$2,'BR001','الفرع الرئيسي',$3,$4,TRUE)`,
        [branchId, tenantId, b.address || null, b.owner_phone.trim()]);
      const hash = await bcrypt.hash(b.admin_password, bcryptRounds());
      await client.query(
        `INSERT INTO users (tenant_id, branch_id, username, password_hash, full_name, role)
         VALUES ($1,$2,$3,$4,$5,'tenant_admin')`,
        [tenantId, branchId, b.admin_username.trim(), hash, b.owner_name.trim()]);
      return { id: tenantId, tenant_code: tenantCode };
    });
    await logActivity(req, 'create_tenant', 'tenant', result.id, { tenant_code: result.tenant_code });
    res.json({ ok: true, data: result });
  } catch (e) {
    if (e.code === '23505') return res.status(400).json({ ok: false, error: 'اسم المستخدم أو الرمز مكرر، أعد المحاولة' });
    next(e);
  }
});

router.get('/tenants/:id', ownerOnly, async (req, res, next) => {
  try {
    if (!isUuid(req.params.id)) throw new HttpError(404, 'العميل غير موجود');
    const t = await query(
      `SELECT id, tenant_code, business_name, owner_name, owner_phone, owner_email, address, plan,
              is_active, is_suspended, suspension_reason, is_trial, subscription_status, subscription_end,
              max_branches, max_users, max_products, license_key, created_at
         FROM tenants WHERE id = $1`, [req.params.id]);
    if (!t.rows.length) throw new HttpError(404, 'العميل غير موجود');
    const users = await query(
      `SELECT id, username, full_name, role, is_active, last_login FROM users WHERE tenant_id = $1 ORDER BY created_at`, [req.params.id]);
    const branches = await query(
      `SELECT id, branch_code, name, address, is_main, cash_balance FROM branches WHERE tenant_id = $1 ORDER BY is_main DESC, created_at`, [req.params.id]);
    const stats = await query(
      `SELECT (SELECT COUNT(*) FROM products WHERE tenant_id = $1) AS products,
              (SELECT COUNT(*) FROM customers WHERE tenant_id = $1) AS customers,
              (SELECT COUNT(*) FROM invoices WHERE tenant_id = $1 AND status='completed') AS invoices,
              (SELECT COALESCE(SUM(total),0) FROM invoices WHERE tenant_id = $1 AND status='completed') AS total_sales`,
      [req.params.id]);
    res.json({ ok: true, data: { tenant: t.rows[0], users: users.rows, branches: branches.rows, stats: stats.rows[0] } });
  } catch (e) { next(e); }
});

router.put('/tenants/:id', ownerOnly, async (req, res, next) => {
  try {
    if (!isUuid(req.params.id)) throw new HttpError(404, 'العميل غير موجود');
    const b = req.body || {};
    const sets = [], params = [req.params.id];
    const add = (col, val) => { params.push(val); sets.push(`${col} = $${params.length}`); };
    for (const f of ['business_name', 'owner_name', 'owner_phone', 'owner_email', 'address']) {
      if (b[f] !== undefined) add(f, b[f] === '' ? null : String(b[f]).trim());
    }
    if (b.plan !== undefined) { if (!PLAN_NAMES.includes(b.plan)) throw new HttpError(400, 'خطة غير صالحة'); add('plan', b.plan); }
    if (b.max_branches !== undefined) add('max_branches', num(b.max_branches, { name: 'الفروع', min: 1, max: 100 }));
    if (b.max_users !== undefined) add('max_users', num(b.max_users, { name: 'المستخدمون', min: 1, max: 1000 }));
    if (b.max_products !== undefined) add('max_products', num(b.max_products, { name: 'المنتجات', min: 1, max: 1000000 }));
    if (!sets.length) throw new HttpError(400, 'لا توجد بيانات للتعديل');
    sets.push('updated_at = NOW()');
    const r = await query(`UPDATE tenants SET ${sets.join(', ')} WHERE id = $1 RETURNING id`, params);
    if (!r.rows.length) throw new HttpError(404, 'العميل غير موجود');
    await logActivity(req, 'update_tenant', 'tenant', req.params.id);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

router.post('/tenants/:id/renew', ownerOnly, async (req, res, next) => {
  try {
    if (!isUuid(req.params.id)) throw new HttpError(404, 'العميل غير موجود');
    const b = req.body || {};
    let days;
    if (b.days !== undefined) days = num(b.days, { name: 'الأيام', min: 1, max: 3650 });
    else days = num(b.months, { name: 'الأشهر', min: 1, max: 120, def: 1 }) * 30;
    const r = await query(
      `UPDATE tenants SET subscription_status = 'active', is_trial = FALSE,
              subscription_end = GREATEST(COALESCE(subscription_end, NOW()), NOW()) + ($2::int * INTERVAL '1 day'),
              updated_at = NOW()
        WHERE id = $1 RETURNING subscription_end`, [req.params.id, days]);
    if (!r.rows.length) throw new HttpError(404, 'العميل غير موجود');
    await logActivity(req, 'renew_tenant', 'tenant', req.params.id, { days });
    res.json({ ok: true, data: { subscription_end: r.rows[0].subscription_end } });
  } catch (e) { next(e); }
});

router.post('/tenants/:id/suspend', ownerOnly, async (req, res, next) => {
  try {
    if (!isUuid(req.params.id)) throw new HttpError(404, 'العميل غير موجود');
    const suspend = req.body && req.body.suspend === true;
    const r = await query(
      `UPDATE tenants SET is_suspended = $2, suspension_reason = $3, updated_at = NOW()
        WHERE id = $1 RETURNING id`,
      [req.params.id, suspend, suspend ? String((req.body && req.body.reason) || 'غير محدد').slice(0, 300) : null]);
    if (!r.rows.length) throw new HttpError(404, 'العميل غير موجود');
    await logActivity(req, suspend ? 'suspend_tenant' : 'activate_tenant', 'tenant', req.params.id);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// إعادة تعيين كلمة مرور مستخدم عند عميل (دعم فني) — يُبطل جلساته
router.post('/tenants/:id/reset-password', ownerOnly, async (req, res, next) => {
  try {
    if (!isUuid(req.params.id)) throw new HttpError(404, 'العميل غير موجود');
    const { username, new_password } = req.body || {};
    const weak = checkPasswordStrength(new_password);
    if (weak) throw new HttpError(400, weak);
    const hash = await bcrypt.hash(new_password, bcryptRounds());
    const r = await query(
      `UPDATE users SET password_hash = $1, token_version = token_version + 1, updated_at = NOW()
        WHERE tenant_id = $2 AND username = $3 RETURNING id`, [hash, req.params.id, username]);
    if (!r.rows.length) throw new HttpError(404, 'المستخدم غير موجود');
    await logActivity(req, 'change_password', 'user', r.rows[0].id, { by: 'owner' });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// ============================================
// أكواد الترخيص
// ============================================
router.post('/license-codes', ownerOnly, async (req, res, next) => {
  try {
    const b = req.body || {};
    const count = num(b.count, { name: 'العدد', min: 1, max: 200, def: 1 });
    if (b.tenant_id && !isUuid(b.tenant_id)) throw new HttpError(400, 'معرّف العميل غير صالح');
    const codes = await transaction(client =>
      createCodes(client, { plan: b.plan, count, tenantId: b.tenant_id || null, createdBy: req.user.id }));
    await logActivity(req, 'create_license_codes', 'license', null, { plan: b.plan, count });
    // الأكواد الأصلية تُعرض هنا فقط ولا تُخزَّن
    res.json({ ok: true, data: { plan: b.plan, plan_name: PLANS[b.plan].name, codes } });
  } catch (e) { next(e); }
});

router.get('/license-codes', ownerOnly, async (req, res, next) => {
  try {
    const r = await query(
      `SELECT lc.id, lc.code_hint, lc.plan, lc.duration_minutes, lc.created_at, lc.used_at,
              lc.tenant_id, t.business_name AS used_by
         FROM license_codes lc LEFT JOIN tenants t ON t.id = lc.used_by_tenant
        ORDER BY lc.created_at DESC LIMIT 500`);
    res.json({ ok: true, data: r.rows });
  } catch (e) { next(e); }
});

// ============================================
// سجل النشاطات
// ============================================
router.get('/activity', ownerOnly, async (req, res, next) => {
  try {
    const limit = Math.min(500, Math.max(1, parseInt(req.query.limit) || 100));
    const r = await query(
      `SELECT a.id, a.action, a.entity_type, a.entity_id, a.created_at,
              u.full_name AS user_name, t.business_name
         FROM activity_log a
         LEFT JOIN users u ON u.id = a.user_id
         LEFT JOIN tenants t ON t.id = a.tenant_id
        ORDER BY a.created_at DESC LIMIT $1`, [limit]);
    res.json({ ok: true, data: r.rows });
  } catch (e) { next(e); }
});

module.exports = router;
