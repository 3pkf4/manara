const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const router = express.Router();
const { query } = require('../db');
const { authenticate, checkUser, checkTenantActive, signToken } = require('../middleware/auth');
const { logActivity } = require('../middleware/logger');

// ============================================
// توليد بصمة قوية للجهاز
// ============================================
function generateDeviceId(req) {
  const ua = req.headers['user-agent'] || '';
  const ip = req.ip || req.connection.remoteAddress || '';
  const acceptLang = req.headers['accept-language'] || '';
  const acceptEnc = req.headers['accept-encoding'] || '';
  
  // بصمة مركبة
  const fingerprint = `${ua}|${ip}|${acceptLang}|${acceptEnc}`;
  return crypto.createHash('sha256').update(fingerprint).digest('hex').substring(0, 32);
}

// ============================================
// تسجيل محاولة دخول
// ============================================
async function recordLoginAttempt(username, deviceId, req, success, reason = null) {
  try {
    await query(
      `INSERT INTO login_attempts 
       (username, device_id, ip_address, user_agent, success, reason)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [username, deviceId, req.ip, req.headers['user-agent'], success, reason]
    );
  } catch (e) {
    console.error('Failed to log login attempt:', e.message);
  }
}

// ============================================
// تسجيل الدخول
// ============================================
const DUMMY_HASH = bcrypt.hashSync('manara-dummy-password', 10); // لتوحيد زمن الاستجابة

router.post('/login', async (req, res, next) => {
  try {
    const { username, password, tenant_code, device_id: clientDeviceId } = req.body || {};

    if (typeof username !== 'string' || typeof password !== 'string' || !username || !password) {
      return res.status(400).json({ ok: false, error: 'الرجاء إدخال البيانات' });
    }
    if (username.length > 50 || password.length > 200) {
      return res.status(400).json({ ok: false, error: 'بيانات الدخول غير صحيحة' });
    }

    const deviceId = (typeof clientDeviceId === 'string' && clientDeviceId.length <= 100)
      ? clientDeviceId : generateDeviceId(req);

    // قفل مؤقت ضد التخمين: (اسم المستخدم + IP) أو اسم المستخدم عموماً
    const lock = await query(
      `WITH last_ok AS (
         SELECT COALESCE(MAX(created_at), 'epoch'::timestamptz) AS t
           FROM login_attempts WHERE username = $1 AND success = TRUE)
       SELECT
         COUNT(*) FILTER (WHERE ip_address = $2) AS from_ip,
         COUNT(*) AS total
       FROM login_attempts, last_ok
       WHERE username = $1 AND success = FALSE
         AND created_at > GREATEST(NOW() - INTERVAL '15 minutes', last_ok.t)`,
      [username, req.ip]
    );
    if (parseInt(lock.rows[0].from_ip) >= 8 || parseInt(lock.rows[0].total) >= 40) {
      return res.status(429).json({ ok: false, error: 'محاولات كثيرة. حاول بعد 15 دقيقة', code: 'TOO_MANY_ATTEMPTS' });
    }

    // المرشحون: اسم المستخدم فريد لكل متجر فقط، لذلك قد يوجد أكثر من مرشح
    const params = [username];
    let tenantFilter = '';
    if (tenant_code) {
      params.push(String(tenant_code).trim().toUpperCase());
      tenantFilter = ' AND UPPER(t.tenant_code) = $2';
    }
    const r = await query(
      `SELECT
         u.id, u.username, u.password_hash, u.full_name, u.role, u.is_active, u.token_version,
         u.tenant_id, u.branch_id,
         t.business_name, t.tenant_code, t.is_active AS tenant_active,
         t.is_suspended, t.subscription_end,
         b.name AS branch_name, b.branch_code
       FROM users u
       LEFT JOIN tenants t ON t.id = u.tenant_id
       LEFT JOIN branches b ON b.id = u.branch_id
       WHERE u.username = $1 ${tenantFilter}
       LIMIT 20`,
      params
    );

    // نفحص كلمة المرور لكل مرشح (دائماً مرة واحدة على الأقل لتوحيد الزمن)
    const matches = [];
    if (!r.rows.length) await bcrypt.compare(password, DUMMY_HASH);
    for (const cand of r.rows) {
      if (await bcrypt.compare(password, cand.password_hash)) matches.push(cand);
    }

    if (!matches.length) {
      await recordLoginAttempt(username, deviceId, req, false, 'بيانات غير صحيحة');
      return res.status(401).json({ ok: false, error: 'بيانات الدخول غير صحيحة' });
    }
    if (matches.length > 1) {
      return res.status(409).json({
        ok: false, code: 'TENANT_CODE_REQUIRED',
        error: 'اسم المستخدم مستخدم في أكثر من متجر. أدخل رمز المتجر.'
      });
    }
    const user = matches[0];

    if (!user.is_active) {
      await recordLoginAttempt(username, deviceId, req, false, 'الحساب معطل');
      return res.status(403).json({ ok: false, error: 'الحساب معطل' });
    }

    // فحص المتجر
    if (user.role !== 'owner' && user.tenant_id) {
      if (!user.tenant_active || user.is_suspended) {
        await recordLoginAttempt(username, deviceId, req, false, 'الاشتراك موقوف');
        return res.status(403).json({ ok: false, error: 'الحساب موقوف', code: 'TENANT_SUSPENDED' });
      }
      if (!user.subscription_end || new Date(user.subscription_end) < new Date()) {
        await recordLoginAttempt(username, deviceId, req, false, 'انتهى الاشتراك');
        return res.status(403).json({ ok: false, error: 'انتهى الاشتراك', code: 'SUBSCRIPTION_EXPIRED' });
      }
    }

    // ============================================
    // 🔒 فحص الجهاز
    // ============================================
    let deviceRegistered = false;
    let deviceNeedsSetup = false;
    let registeredBranchId = null;
    let registeredBranchName = null;
    const isAdmin = ['owner', 'tenant_admin'].includes(user.role);

    if (!isAdmin && user.tenant_id) {
      const deviceCheck = await query(
        `SELECT d.*, b.name AS branch_name
         FROM branch_devices d
         LEFT JOIN branches b ON b.id = d.branch_id
         WHERE d.tenant_id = $1 AND d.device_id = $2 AND d.is_active = TRUE`,
        [user.tenant_id, deviceId]
      );

      if (deviceCheck.rows.length > 0) {
        const device = deviceCheck.rows[0];
        deviceRegistered = true;
        registeredBranchId = device.branch_id;
        registeredBranchName = device.branch_name;

        if (user.branch_id && device.branch_id !== user.branch_id) {
          await recordLoginAttempt(username, deviceId, req, false,
            `محاولة دخول من جهاز "${device.branch_name}" بدلاً من "${user.branch_name}"`);
          return res.status(403).json({
            ok: false,
            code: 'WRONG_BRANCH',
            error: `هذا الحاسوب مسجل في "${device.branch_name}". أنت تابع لفرع "${user.branch_name}". لا يمكنك الدخول من هذا الجهاز.`,
            registered_branch: device.branch_name,
            user_branch: user.branch_name
          });
        }
        await query('UPDATE branch_devices SET last_seen = NOW() WHERE id = $1', [device.id]);
      } else {
        deviceNeedsSetup = true;
      }
    }

    const payload = {
      id: user.id,
      username: user.username,
      name: user.full_name,
      role: user.role,
      tenantId: user.tenant_id,
      branchId: user.branch_id,
      deviceId: deviceId,
      tv: user.token_version
    };
    const token = signToken(payload);

    await query('UPDATE users SET last_login = NOW(), last_ip = $1 WHERE id = $2', [req.ip, user.id]);
    await recordLoginAttempt(username, deviceId, req, true);

    req.user = payload;
    req.tenantId = user.tenant_id;
    await logActivity(req, 'login', 'user', user.id, { device_id: deviceId });

    res.json({
      ok: true,
      token,
      deviceId,
      deviceRegistered,
      deviceNeedsSetup,
      registered_branch_id: registeredBranchId,
      registered_branch_name: registeredBranchName,
      user: {
        id: user.id,
        username: user.username,
        name: user.full_name,
        role: user.role,
        tenant_id: user.tenant_id,
        tenant_name: user.business_name,
        tenant_code: user.tenant_code,
        branch_id: user.branch_id,
        branch_name: user.branch_name,
        branch_code: user.branch_code
      }
    });
  } catch (e) {
    next(e);
  }
});

// ============================================
// تغيير كلمة المرور (المستخدم نفسه) — يُبطل كل الرموز القديمة
// ============================================
router.post('/change-password', authenticate, checkUser, async (req, res, next) => {
  try {
    const { current_password, new_password } = req.body || {};
    if (typeof current_password !== 'string' || typeof new_password !== 'string') {
      return res.status(400).json({ ok: false, error: 'البيانات ناقصة' });
    }
    const { checkPasswordStrength } = require('../lib/password');
    const weak = checkPasswordStrength(new_password);
    if (weak) return res.status(400).json({ ok: false, error: weak });

    const r = await query('SELECT password_hash FROM users WHERE id = $1', [req.user.id]);
    if (!r.rows.length || !(await bcrypt.compare(current_password, r.rows[0].password_hash))) {
      return res.status(403).json({ ok: false, error: 'كلمة المرور الحالية غير صحيحة' });
    }
    const hash = await bcrypt.hash(new_password, require('../lib/config').bcryptRounds());
    const u = await query(
      'UPDATE users SET password_hash = $1, token_version = token_version + 1, updated_at = NOW() WHERE id = $2 RETURNING token_version',
      [hash, req.user.id]
    );
    await logActivity(req, 'change_password', 'user', req.user.id);
    const token = signToken({
      id: req.user.id, username: req.user.username, name: req.user.name, role: req.user.role,
      tenantId: req.user.tenantId, branchId: req.user.branchId, deviceId: req.user.deviceId,
      tv: u.rows[0].token_version
    });
    res.json({ ok: true, token, message: 'تم تغيير كلمة المرور' });
  } catch (e) { next(e); }
});

// ============================================
// تسجيل الجهاز الحالي (يُستدعى من المدير)
// ============================================
router.post('/register-device', authenticate, checkTenantActive, async (req, res, next) => {
  try {
    if (!['owner', 'tenant_admin'].includes(req.user.role)) {
      return res.status(403).json({ ok: false, error: 'لا تملك الصلاحية' });
    }

    const { device_id, device_name, branch_id, device_info } = req.body;
    if (!device_id || !branch_id) {
      return res.status(400).json({ ok: false, error: 'device_id و branch_id مطلوبان' });
    }

    // التحقق من الفرع
    const branch = await query(
      'SELECT id, name FROM branches WHERE id = $1 AND tenant_id = $2',
      [branch_id, req.tenantId]
    );
    if (!branch.rows.length) {
      return res.status(404).json({ ok: false, error: 'الفرع غير موجود' });
    }

    const r = await query(
      `INSERT INTO branch_devices 
       (tenant_id, branch_id, device_id, device_name, device_info, registered_by)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (tenant_id, device_id) 
       DO UPDATE SET 
         branch_id = EXCLUDED.branch_id,
         device_name = EXCLUDED.device_name,
         device_info = EXCLUDED.device_info,
         is_active = TRUE,
         last_seen = NOW()
       RETURNING *`,
      [req.tenantId, branch_id, device_id, 
       device_name || 'كاشير', 
       JSON.stringify(device_info || {}), 
       req.user.id]
    );

    await logActivity(req, 'register_device', 'device', r.rows[0].id, {
      device_name, branch_name: branch.rows[0].name
    });

    res.json({ 
      ok: true, 
      data: r.rows[0],
      branch_name: branch.rows[0].name
    });
  } catch (e) { next(e); }
});

// ============================================
// جلب أجهزة المستأجر
// ============================================
router.get('/devices', authenticate, checkTenantActive, async (req, res, next) => {
  try {
    let sql = `
      SELECT d.*, 
             b.name AS branch_name, b.branch_code,
             u.full_name AS registered_by_name
      FROM branch_devices d
      LEFT JOIN branches b ON b.id = d.branch_id
      LEFT JOIN users u ON u.id = d.registered_by
      WHERE d.tenant_id = $1`;
    const params = [req.tenantId];
    let i = 2;

    // مدير الفرع يرى أجهزة فرعه فقط
    if (req.user.role === 'branch_manager' && req.branchId) {
      sql += ` AND d.branch_id = $${i}`;
      params.push(req.branchId);
      i++;
    }

    sql += ' ORDER BY d.last_seen DESC';
    const r = await query(sql, params);
    res.json({ ok: true, data: r.rows });
  } catch (e) { next(e); }
});

// ============================================
// حذف جهاز
// ============================================
router.delete('/devices/:id', authenticate, checkTenantActive, async (req, res, next) => {
  try {
    if (!['owner', 'tenant_admin'].includes(req.user.role)) {
      return res.status(403).json({ ok: false, error: 'لا تملك الصلاحية' });
    }
    await query(
      'DELETE FROM branch_devices WHERE id = $1 AND tenant_id = $2',
      [req.params.id, req.tenantId]
    );
    await logActivity(req, 'delete_device', 'device', req.params.id);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// ============================================
// معلومات المستخدم الحالي
// ============================================
router.get('/me', authenticate, checkUser, async (req, res, next) => {
  try {
    const r = await query(
      `SELECT 
         u.id, u.username, u.full_name, u.role, u.email, u.phone,
         u.tenant_id, u.branch_id,
         t.business_name, t.tenant_code, t.currency, t.language,
         b.name AS branch_name, b.branch_code
       FROM users u
       LEFT JOIN tenants t ON t.id = u.tenant_id
       LEFT JOIN branches b ON b.id = u.branch_id
       WHERE u.id = $1`,
      [req.user.id]
    );
    if (!r.rows.length) return res.status(404).json({ ok: false, error: 'المستخدم غير موجود' });
    res.json({ ok: true, data: r.rows[0] });
  } catch (e) { next(e); }
});

// ============================================
// تسجيل الخروج
// ============================================
router.post('/logout', authenticate, checkUser, async (req, res, next) => {
  try {
    await logActivity(req, 'logout', 'user', req.user.id);
    res.json({ ok: true });
  } catch (e) { next(e); }
});
// ============================================
// سجل الدخول (Login History)
// ============================================
router.get('/login-history', authenticate, checkTenantActive, async (req, res, next) => {
  try {
    if (!['owner', 'tenant_admin', 'branch_manager'].includes(req.user.role)) {
      return res.status(403).json({ ok: false, error: 'لا تملك الصلاحية' });
    }

    const { limit = 200, branch_id } = req.query;

    let sql = `
      SELECT 
        la.id,
        la.username,
        la.device_id,
        la.ip_address,
        la.success,
        la.reason,
        la.created_at,
        u.full_name,
        u.role,
        b.name AS branch_name,
        b.branch_code,
        d.device_name
      FROM login_attempts la
      LEFT JOIN users u ON u.username = la.username AND u.tenant_id = $1
      LEFT JOIN branch_devices d ON d.device_id = la.device_id
      LEFT JOIN branches b ON b.id = u.branch_id
      WHERE u.tenant_id = $1
    `;
    const params = [req.tenantId];
    let i = 2;

    if (req.user.role === 'branch_manager' && req.branchId) {
      sql += ` AND u.branch_id = $${i}`;
      params.push(req.branchId);
      i++;
    } else if (branch_id) {
      sql += ` AND u.branch_id = $${i}`;
      params.push(branch_id);
      i++;
    }

    sql += ` ORDER BY la.created_at DESC LIMIT $${i}`;
    params.push(parseInt(limit));

    const r = await query(sql, params);
    res.json({ ok: true, data: r.rows });
  } catch (e) { next(e); }
});

// ============================================
// الأجهزة النشطة (ظهرت آخر 7 أيام)
// ============================================
router.get('/devices-online', authenticate, checkTenantActive, async (req, res, next) => {
  try {
    if (!['owner', 'tenant_admin', 'branch_manager'].includes(req.user.role)) {
      return res.status(403).json({ ok: false, error: 'لا تملك الصلاحية' });
    }

    const r = await query(
      `SELECT 
        d.id,
        d.device_name,
        d.device_id,
        d.last_seen,
        b.name AS branch_name,
        b.branch_code,
        (SELECT COUNT(*) FROM login_attempts 
         WHERE device_id = d.device_id 
           AND success = TRUE 
           AND created_at > NOW() - INTERVAL '24 hours') AS logins_24h,
        (SELECT username FROM login_attempts 
         WHERE device_id = d.device_id 
           AND success = TRUE 
         ORDER BY created_at DESC LIMIT 1) AS last_user
      FROM branch_devices d
      LEFT JOIN branches b ON b.id = d.branch_id
      WHERE d.tenant_id = $1 
        AND d.last_seen > NOW() - INTERVAL '7 days'
      ORDER BY d.last_seen DESC`,
      [req.tenantId]
    );

    res.json({ ok: true, data: r.rows });
  } catch (e) { next(e); }
});

module.exports = router;
