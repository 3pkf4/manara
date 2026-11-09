/**
 * دخول جهاز الكاشير بمسح QR.
 *  - المدير ينشئ رمزاً لحساب كاشير/مخزنجي (لا للمدراء)، صالحاً 10 دقائق ولمرة واحدة.
 *  - الرمز يُخزَّن مجزّأً (SHA-256) ويُرسل داخل الرابط بعد # فلا يصل لسجلات الخوادم.
 *  - عند المسح يُسجَّل الجهاز في فرع المستخدم تلقائياً (المدير هو من اعتمده)، وتُصدر جلسة أطول (QR_SESSION_EXPIRY، الافتراضي 7d)
 *    تُبطَل بتعطيل الحساب أو تغيير كلمة مروره (token_version).
 */
const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const { query, transaction } = require('../db');
const { authenticate, requireRole, checkTenantActive, signToken } = require('../middleware/auth');
const { logActivity } = require('../middleware/logger');
const { HttpError } = require('../lib/util');
const { getBranchFilter } = require('../middleware/branch-filter');

const PAIRABLE = ['cashier', 'warehouse'];
const TTL_MIN = 10;
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const isUuid = (v) => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);

function baseUrl(req) {
  const pub = (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');
  return /^https:\/\/[^/\s]+/.test(pub) ? pub : `${req.protocol}://${req.get('host')}`;
}

router.post('/create', authenticate, checkTenantActive, requireRole('tenant_admin', 'branch_manager'), async (req, res, next) => {
  try {
    const userId = (req.body || {}).user_id;
    if (!isUuid(userId)) throw new HttpError(400, 'مستخدم غير صالح');
    const u = (await query('SELECT id, role, branch_id, is_active, full_name FROM users WHERE id = $1 AND tenant_id = $2', [userId, req.tenantId])).rows[0];
    if (!u) throw new HttpError(404, 'المستخدم غير موجود');
    if (!u.is_active) throw new HttpError(400, 'الحساب معطل');
    if (!PAIRABLE.includes(u.role)) throw new HttpError(403, 'الدخول بـ QR متاح لحسابات الكاشير والمخزنجي فقط');
    const bf = getBranchFilter(req);
    if (bf.scope === 'own' && u.branch_id !== bf.branchId) throw new HttpError(403, 'هذا المستخدم ليس في فرعك');
    const recent = (await query(
      `SELECT COUNT(*)::int n FROM device_login_tokens WHERE tenant_id = $1 AND created_at > NOW() - INTERVAL '1 hour'`, [req.tenantId])).rows[0].n;
    if (recent >= 60) throw new HttpError(429, 'رموز كثيرة، حاول بعد قليل');

    const token = crypto.randomBytes(32).toString('base64url');
    const r = await query(
      `INSERT INTO device_login_tokens (tenant_id, user_id, token_hash, expires_at, created_by)
       VALUES ($1,$2,$3, NOW() + ($4::int * INTERVAL '1 minute'), $5) RETURNING expires_at`,
      [req.tenantId, u.id, sha(token), TTL_MIN, req.user.id]);
    await logActivity(req, 'qr_create', 'user', u.id, { for: u.full_name });
    res.json({ ok: true, data: { url: baseUrl(req) + '/#qr=' + token, expires_at: r.rows[0].expires_at, minutes: TTL_MIN, user: u.full_name } });
  } catch (e) { next(e); }
});

router.post('/redeem', async (req, res, next) => {
  try {
    const token = String((req.body || {}).token || '');
    const deviceIdIn = (req.body || {}).device_id;
    if (!/^[A-Za-z0-9_-]{40,60}$/.test(token)) return res.status(401).json({ ok: false, error: 'الرمز غير صالح أو منتهٍ' });
    const deviceId = typeof deviceIdIn === 'string' && /^[\w.-]{6,100}$/.test(deviceIdIn) ? deviceIdIn : 'qr-' + crypto.randomBytes(6).toString('hex');
    const deviceName = String((req.body || {}).device_name || 'هاتف كاشير').slice(0, 100);

    const out = await transaction(async (client) => {
      // استهلاك ذرّي: يفشل أي استعمال ثانٍ أو بعد الانتهاء
      const t = (await client.query(
        `UPDATE device_login_tokens SET used_at = NOW()
          WHERE token_hash = $1 AND used_at IS NULL AND expires_at > NOW() RETURNING tenant_id, user_id`, [sha(token)])).rows[0];
      if (!t) return { status: 401, body: { ok: false, error: 'الرمز غير صالح أو منتهٍ' } };
      const u = (await client.query(
        `SELECT u.id, u.username, u.full_name, u.role, u.is_active, u.token_version, u.tenant_id, u.branch_id,
                tn.business_name, tn.tenant_code, tn.is_active AS tenant_active, tn.is_suspended, tn.subscription_end,
                b.name AS branch_name, b.branch_code
           FROM users u JOIN tenants tn ON tn.id = u.tenant_id LEFT JOIN branches b ON b.id = u.branch_id
          WHERE u.id = $1 AND u.tenant_id = $2`, [t.user_id, t.tenant_id])).rows[0];
      if (!u || !u.is_active || !PAIRABLE.includes(u.role)) return { status: 403, body: { ok: false, error: 'الحساب معطل' } };
      if (!u.tenant_active || u.is_suspended) return { status: 403, body: { ok: false, error: 'الحساب موقوف', code: 'TENANT_SUSPENDED' } };
      if (!u.subscription_end || new Date(u.subscription_end) < new Date()) return { status: 403, body: { ok: false, error: 'انتهى الاشتراك', code: 'SUBSCRIPTION_EXPIRED' } };

      if (u.branch_id) {
        await client.query(
          `INSERT INTO branch_devices (tenant_id, branch_id, device_id, device_name, device_info, registered_by)
           VALUES ($1,$2,$3,$4,$5,$6)
           ON CONFLICT (tenant_id, device_id) DO UPDATE SET branch_id = EXCLUDED.branch_id, device_name = EXCLUDED.device_name, is_active = TRUE, last_seen = NOW()`,
          [u.tenant_id, u.branch_id, deviceId, deviceName, JSON.stringify({ via: 'qr' }), u.id]);
      }
      await client.query('UPDATE users SET last_login = NOW(), last_ip = $1 WHERE id = $2', [req.ip, u.id]);
      const payload = { id: u.id, username: u.username, name: u.full_name, role: u.role, tenantId: u.tenant_id, branchId: u.branch_id, deviceId, tv: u.token_version };
      return { status: 200, payload, u, deviceId };
    });
    if (out.status !== 200) return res.status(out.status).json(out.body);
    const { u, payload } = out;
    req.user = payload; req.tenantId = u.tenant_id;
    await logActivity(req, 'qr_login', 'user', u.id, { device_id: out.deviceId });
    res.json({
      ok: true, token: signToken(payload, process.env.QR_SESSION_EXPIRY || '7d'), deviceId: out.deviceId, deviceRegistered: !!u.branch_id, deviceNeedsSetup: false,
      user: { id: u.id, username: u.username, name: u.full_name, role: u.role, tenant_id: u.tenant_id, tenant_name: u.business_name,
              tenant_code: u.tenant_code, branch_id: u.branch_id, branch_name: u.branch_name, branch_code: u.branch_code }
    });
  } catch (e) { next(e); }
});

module.exports = router;
