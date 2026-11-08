const jwt = require('jsonwebtoken');
const { query } = require('../db');

const ROLES = ['owner', 'tenant_admin', 'branch_manager', 'cashier', 'warehouse', 'accountant'];
// الأدوار التي يستطيع مدير المتجر إنشاؤها (owner غير مسموح أبداً عبر الـ API)
const ASSIGNABLE_ROLES = ROLES.filter(r => r !== 'owner');

function signToken(payload, expiresIn) {
  const { jwtExpiry } = require('../lib/config');
  return jwt.sign(payload, process.env.JWT_SECRET, { algorithm: 'HS256', expiresIn: expiresIn || jwtExpiry() });
}

/** يتحقق من التوقيع فقط (بدون قاعدة بيانات). */
function authenticate(req, res, next) {
  const header = req.headers['authorization'] || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ ok: false, error: 'غير مخوّل (لا يوجد رمز)', code: 'NO_TOKEN' });

  jwt.verify(token, process.env.JWT_SECRET, { algorithms: ['HS256'] }, (err, user) => {
    if (err) {
      const expired = err.name === 'TokenExpiredError';
      return res.status(401).json({
        ok: false,
        error: expired ? 'انتهت الجلسة، سجّل الدخول مجدداً' : 'الرمز غير صالح',
        code: expired ? 'TOKEN_EXPIRED' : 'TOKEN_INVALID'
      });
    }
    req.user = user;
    req.tenantId = user.tenantId || null;
    req.branchId = user.branchId || null;
    next();
  });
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ ok: false, error: 'لا تملك الصلاحية الكافية', code: 'FORBIDDEN' });
    }
    next();
  };
}

/**
 * فحص الحالة الحيّة من قاعدة البيانات (استعلام واحد):
 *  - المستخدم ما زال موجوداً ونشطاً، ولم تُغيَّر كلمة مروره/صلاحياته بعد إصدار الرمز
 *  - المتجر نشط وغير موقوف واشتراكه ساري
 * المالك (owner) بلا متجر فيُتحقق من حسابه فقط.
 */
function makeCheck(checkSubscription) {
  return async function (req, res, next) {
  try {
    const r = await query(
      `SELECT u.is_active AS user_active, u.token_version, u.role, u.branch_id,
              t.is_active AS t_active, t.is_suspended, t.subscription_status, t.subscription_end
         FROM users u
         LEFT JOIN tenants t ON t.id = u.tenant_id
        WHERE u.id = $1`,
      [req.user.id]
    );
    if (!r.rows.length) {
      return res.status(401).json({ ok: false, error: 'الحساب غير موجود', code: 'ACCOUNT_DISABLED' });
    }
    const row = r.rows[0];
    if (!row.user_active || (req.user.tv !== undefined ? req.user.tv : 0) !== row.token_version) {
      return res.status(401).json({ ok: false, error: 'انتهت صلاحية الجلسة، سجّل الدخول مجدداً', code: 'TOKEN_REVOKED' });
    }
    // الدور والفرع يُؤخذان من القاعدة لا من الرمز (تغييرهما يسري فوراً)
    req.user.role = row.role;
    req.branchId = row.branch_id || null;

    if (row.role === 'owner' || !checkSubscription) return next();
    if (!req.tenantId) return res.status(401).json({ ok: false, error: 'المتجر غير موجود', code: 'NO_TENANT' });

    if (!row.t_active || row.is_suspended) {
      return res.status(403).json({ ok: false, error: 'الحساب موقوف', code: 'TENANT_SUSPENDED' });
    }
    if (row.subscription_status !== 'active' ||
        !row.subscription_end || new Date(row.subscription_end) < new Date()) {
      return res.status(403).json({
        ok: false,
        error: 'اشتراكك منتهي. يرجى تجديد الاشتراك للوصول إلى النظام.',
        code: 'SUBSCRIPTION_EXPIRED'
      });
    }
    next();
  } catch (e) { next(e); }
  };
}

const checkTenantActive = makeCheck(true);
/** نفس الفحص بدون الاشتراك (لمسارات الحساب: me/logout/تفعيل الكود) */
const checkUser = makeCheck(false);

/** يمنع الاستعلام بدون متجر (حساب المالك) في مسارات خاصة بالمتاجر */
function requireTenant(req, res, next) {
  if (!req.tenantId) {
    return res.status(400).json({ ok: false, error: 'هذا المسار خاص بحسابات المتاجر', code: 'TENANT_REQUIRED' });
  }
  next();
}

module.exports = { authenticate, requireRole, checkTenantActive, checkUser, requireTenant, signToken, ROLES, ASSIGNABLE_ROLES };
