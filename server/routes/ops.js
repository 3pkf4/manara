/**
 * واجهة الدعم والإدارة للمالك (تُستعمل من لوحة Apps Script).
 * مفتاح ثابت منفصل (OPS_API_KEY) بدل كلمة مرور المالك: يُلغى بتغيير المتغير فقط.
 * كل عملية تُسجَّل في ops_audit باسم المنفّذ (X-Ops-Actor).
 * لا تُرجع بيانات تشغيلية حساسة للعميل (فواتير/منتجات)، فقط ما يحتاجه الدعم.
 */
const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const router = express.Router();
const { query, transaction } = require('../db');
const { HttpError, num } = require('../lib/util');
const { PLANS, createCodes, extendSubscription } = require('../lib/license');
const { bcryptRounds } = require('../lib/config');

const isUuid = (v) => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest();

router.use((req, res, next) => {
  const key = process.env.OPS_API_KEY || '';
  if (key.length < 32) return res.status(503).json({ ok: false, error: 'واجهة الدعم غير مفعّلة' });
  const given = req.get('X-Ops-Key') || '';
  if (!crypto.timingSafeEqual(sha(given), sha(key))) {
    return res.status(401).json({ ok: false, error: 'مفتاح غير صالح' });
  }
  req.actor = String(req.get('X-Ops-Actor') || 'unknown').slice(0, 200);
  next();
});

async function audit(req, action, tenantId, detail = {}) {
  await query('INSERT INTO ops_audit (actor, action, tenant_id, detail) VALUES ($1,$2,$3,$4)',
    [req.actor, action, tenantId || null, detail]);
}
const tenantOr404 = async (id) => {
  if (!isUuid(id)) throw new HttpError(404, 'العميل غير موجود');
  const r = await query('SELECT id, tenant_code, business_name FROM tenants WHERE id = $1', [id]);
  if (!r.rows.length) throw new HttpError(404, 'العميل غير موجود');
  return r.rows[0];
};

// ملخص اللوحة
router.get('/summary', async (req, res, next) => {
  try {
    const t = (await query(`
      SELECT COUNT(*)::int AS total,
             COUNT(*) FILTER (WHERE is_suspended)::int AS suspended,
             COUNT(*) FILTER (WHERE NOT is_suspended AND subscription_status='active' AND subscription_end > NOW())::int AS active,
             COUNT(*) FILTER (WHERE NOT is_suspended AND (subscription_end IS NULL OR subscription_end <= NOW()))::int AS expired,
             COUNT(*) FILTER (WHERE NOT is_suspended AND subscription_end > NOW() AND subscription_end <= NOW() + INTERVAL '7 days')::int AS expiring_7d,
             COUNT(*) FILTER (WHERE is_trial AND subscription_end > NOW())::int AS on_trial,
             COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '30 days')::int AS new_30d
        FROM tenants`)).rows[0];
    const p = (await query(`
      SELECT COALESCE(SUM(amount) FILTER (WHERE status='paid'),0)::float AS revenue_total,
             COALESCE(SUM(amount) FILTER (WHERE status='paid' AND paid_at >= date_trunc('month', NOW())),0)::float AS revenue_month,
             COUNT(*) FILTER (WHERE status='paid' AND paid_at >= date_trunc('month', NOW()))::int AS paid_month,
             COUNT(*) FILTER (WHERE status='pending' AND created_at > NOW() - INTERVAL '1 day')::int AS pending_24h,
             COUNT(*) FILTER (WHERE status='mismatch')::int AS mismatch
        FROM payment_orders`)).rows[0];
    res.json({ ok: true, data: { tenants: t, payments: p } });
  } catch (e) { next(e); }
});

// العملاء
router.get('/tenants', async (req, res, next) => {
  try {
    const params = [], where = [];
    if (req.query.search) {
      params.push(`%${String(req.query.search).slice(0, 100)}%`);
      where.push(`(t.business_name ILIKE $${params.length} OR t.tenant_code ILIKE $${params.length} OR t.owner_name ILIKE $${params.length} OR t.owner_phone ILIKE $${params.length})`);
    }
    const st = req.query.status;
    if (st === 'active') where.push(`NOT t.is_suspended AND t.subscription_end > NOW()`);
    else if (st === 'expired') where.push(`NOT t.is_suspended AND (t.subscription_end IS NULL OR t.subscription_end <= NOW())`);
    else if (st === 'expiring') where.push(`NOT t.is_suspended AND t.subscription_end > NOW() AND t.subscription_end <= NOW() + INTERVAL '7 days'`);
    else if (st === 'suspended') where.push(`t.is_suspended`);
    const r = await query(`
      SELECT t.id, t.tenant_code, t.business_name, t.owner_name, t.owner_phone, t.owner_email,
             t.is_suspended, t.is_trial, t.subscription_end, t.created_at,
             CASE WHEN t.is_suspended THEN 'suspended' WHEN t.subscription_end IS NULL OR t.subscription_end <= NOW() THEN 'expired'
                  WHEN t.subscription_end <= NOW() + INTERVAL '7 days' THEN 'expiring' ELSE 'active' END AS state
        FROM tenants t ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
       ORDER BY t.subscription_end ASC NULLS FIRST LIMIT 300`, params);
    res.json({ ok: true, data: r.rows });
  } catch (e) { next(e); }
});

router.get('/tenants/:id', async (req, res, next) => {
  try {
    await tenantOr404(req.params.id);
    const t = (await query(`
      SELECT t.id, t.tenant_code, t.business_name, t.owner_name, t.owner_phone, t.owner_email, t.address,
             t.is_suspended, t.suspension_reason, t.is_trial, t.subscription_end, t.created_at,
             t.max_branches, t.max_users, t.max_products,
             (SELECT COUNT(*)::int FROM branches b WHERE b.tenant_id = t.id) AS branch_count,
             (SELECT COUNT(*)::int FROM users u WHERE u.tenant_id = t.id) AS user_count,
             (SELECT COUNT(*)::int FROM products p WHERE p.tenant_id = t.id) AS product_count,
             (SELECT MAX(i.created_at) FROM invoices i WHERE i.tenant_id = t.id) AS last_invoice_at,
             (SELECT COUNT(*)::int FROM invoices i WHERE i.tenant_id = t.id AND i.created_at > NOW() - INTERVAL '30 days') AS invoices_30d
        FROM tenants t WHERE t.id = $1`, [req.params.id])).rows[0];
    const users = (await query(
      `SELECT username, full_name, role, is_active, last_login FROM users WHERE tenant_id = $1 ORDER BY role, username LIMIT 100`, [req.params.id])).rows;
    const payments = (await query(
      `SELECT id, plan, amount, currency, status, gateway, created_at, paid_at FROM payment_orders WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT 20`, [req.params.id])).rows;
    const log = (await query(
      `SELECT actor, action, detail, created_at FROM ops_audit WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT 20`, [req.params.id])).rows;
    res.json({ ok: true, data: { ...t, users, payments, ops_log: log } });
  } catch (e) { next(e); }
});

router.post('/tenants/:id/renew', async (req, res, next) => {
  try {
    const t = await tenantOr404(req.params.id);
    const days = num((req.body || {}).days, { name: 'الأيام', min: 1, max: 3650 });
    const note = String((req.body || {}).note || '').slice(0, 300);
    const end = await transaction(c => extendSubscription(c, t.id, days * 24 * 60));
    await audit(req, 'renew', t.id, { days, note });
    res.json({ ok: true, data: { subscription_end: end } });
  } catch (e) { next(e); }
});

router.post('/tenants/:id/suspend', async (req, res, next) => {
  try {
    const t = await tenantOr404(req.params.id);
    const suspend = (req.body || {}).suspend === true;
    const reason = String((req.body || {}).reason || 'غير محدد').slice(0, 300);
    await query('UPDATE tenants SET is_suspended = $2, suspension_reason = $3, updated_at = NOW() WHERE id = $1', [t.id, suspend, suspend ? reason : null]);
    await audit(req, suspend ? 'suspend' : 'unsuspend', t.id, { reason: suspend ? reason : undefined });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// كلمة مرور مؤقتة عشوائية تُعرض مرة واحدة (الدعم لا يختار كلمة مرور العميل)
router.post('/tenants/:id/reset-password', async (req, res, next) => {
  try {
    const t = await tenantOr404(req.params.id);
    const username = String((req.body || {}).username || '').trim();
    if (!username) throw new HttpError(400, 'اسم المستخدم مطلوب');
    const pick = (s, n) => Array.from(crypto.randomBytes(n), b => s[b % s.length]).join('');
    const temp = pick('ABCDEFGHJKLMNPQRSTUVWXYZ', 4) + pick('abcdefghijkmnpqrstuvwxyz', 5) + pick('23456789', 3) + pick('!@#$%', 2);
    const hash = await bcrypt.hash(temp, bcryptRounds());
    const r = await query(
      `UPDATE users SET password_hash = $1, token_version = token_version + 1, updated_at = NOW()
        WHERE tenant_id = $2 AND LOWER(username) = LOWER($3) RETURNING id`, [hash, t.id, username]);
    if (!r.rows.length) throw new HttpError(404, 'المستخدم غير موجود عند هذا العميل');
    await audit(req, 'reset_password', t.id, { username });
    res.json({ ok: true, data: { username, temp_password: temp } });
  } catch (e) { next(e); }
});

router.get('/payments', async (req, res, next) => {
  try {
    const params = [], where = [];
    if (['pending', 'paid', 'failed', 'mismatch'].includes(req.query.status)) { params.push(req.query.status); where.push(`o.status = $${params.length}`); }
    const r = await query(`
      SELECT o.id, o.plan, o.amount, o.currency, o.status, o.gateway, o.trx_ref, o.created_at, o.paid_at,
             t.business_name, t.tenant_code, t.owner_phone
        FROM payment_orders o JOIN tenants t ON t.id = o.tenant_id
        ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY o.created_at DESC LIMIT 200`, params);
    res.json({ ok: true, data: r.rows });
  } catch (e) { next(e); }
});

router.post('/license-codes', async (req, res, next) => {
  try {
    const b = req.body || {};
    if (!PLANS[b.plan]) throw new HttpError(400, 'خطة غير معروفة');
    const count = num(b.count, { name: 'العدد', min: 1, max: 100, def: 1 });
    if (b.tenant_id && !isUuid(b.tenant_id)) throw new HttpError(400, 'معرّف العميل غير صالح');
    const note = b.note ? String(b.note).slice(0, 200) : null;
    const items = await transaction(c => createCodes(c, { plan: b.plan, count, tenantId: b.tenant_id || null, note, withIds: true }));
    await audit(req, 'license_codes', b.tenant_id || null, { plan: b.plan, count, note });
    res.json({ ok: true, data: { plan: b.plan, plan_name: PLANS[b.plan].name, codes: items.map(i => i.code), items } });
  } catch (e) { next(e); }
});

// قائمة الأكواد (الكود الأصلي لا يُحفظ؛ يظهر آخر 4 رموز فقط)
router.get('/license-codes', async (req, res, next) => {
  try {
    const st = String(req.query.status || '');
    const cond = { unused: 'c.used_at IS NULL AND c.revoked_at IS NULL', used: 'c.used_at IS NOT NULL', revoked: 'c.revoked_at IS NOT NULL' }[st];
    const r = await query(`
      SELECT c.id, c.code_hint, c.plan, c.note, c.created_at, c.used_at, c.revoked_at,
             t.business_name AS used_by, t.tenant_code AS used_by_code,
             CASE WHEN c.revoked_at IS NOT NULL THEN 'revoked' WHEN c.used_at IS NOT NULL THEN 'used' ELSE 'unused' END AS state
        FROM license_codes c LEFT JOIN tenants t ON t.id = c.used_by_tenant
        ${cond ? 'WHERE ' + cond : ''} ORDER BY c.created_at DESC LIMIT 300`);
    res.json({ ok: true, data: r.rows });
  } catch (e) { next(e); }
});

// إتلاف كود غير مستخدم
router.post('/license-codes/:id/revoke', async (req, res, next) => {
  try {
    if (!isUuid(req.params.id)) throw new HttpError(404, 'الكود غير موجود');
    const r = await query(
      `UPDATE license_codes SET revoked_at = NOW() WHERE id = $1 AND used_at IS NULL AND revoked_at IS NULL RETURNING code_hint, plan`, [req.params.id]);
    if (!r.rows.length) throw new HttpError(400, 'الكود غير موجود أو مستخدم/متلف مسبقاً');
    await audit(req, 'license_revoke', null, { hint: r.rows[0].code_hint, plan: r.rows[0].plan });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

router.get('/audit', async (req, res, next) => {
  try {
    const r = await query(`
      SELECT a.id, a.actor, a.action, a.detail, a.created_at, t.business_name
        FROM ops_audit a LEFT JOIN tenants t ON t.id = a.tenant_id ORDER BY a.created_at DESC LIMIT 200`);
    res.json({ ok: true, data: r.rows });
  } catch (e) { next(e); }
});

module.exports = router;
