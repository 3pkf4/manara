/**
 * تحميل الإعدادات والتحقق منها عند الإقلاع.
 * لا توجد أي قيم افتراضية للأسرار: إن لم تُضبط يتوقف الخادم برسالة واضحة.
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../../.env') });

const WEAK_SECRETS = new Set([
  'secret', 'changeme', 'change_me', 'jwt_secret', 'manara', 'manara-super-secret-2026'
]);

function validateEnv() {
  const problems = [];
  const viaUrl = !!process.env.DATABASE_URL;
  if (!viaUrl) for (const k of ['DB_HOST', 'DB_NAME', 'DB_USER']) if (!process.env[k]) problems.push(`المتغير ${k} غير مضبوط (أو اضبط DATABASE_URL)`);

  const jwt = process.env.JWT_SECRET || '';
  if (jwt.length < 32) problems.push('JWT_SECRET يجب أن يكون 32 حرفاً على الأقل');
  if (WEAK_SECRETS.has(jwt.toLowerCase())) problems.push('JWT_SECRET ضعيف/افتراضي');

  if (process.env.NODE_ENV === 'production') {
    if (!viaUrl && !process.env.DB_PASSWORD) problems.push('DB_PASSWORD مطلوب في الإنتاج');
  }
  if (problems.length) {
    const msg = '❌ إعدادات غير صالحة:\n  - ' + problems.join('\n  - ') +
      '\n\nولّد سراً قوياً بالأمر:\n  node -e "console.log(require(\'crypto\').randomBytes(48).toString(\'hex\'))"';
    throw new Error(msg);
  }
}

const bool = (v, d = false) => (v === undefined ? d : ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase()));

module.exports = {
  validateEnv,
  isProd: () => process.env.NODE_ENV === 'production',
  port: () => parseInt(process.env.PORT) || 3000,
  host: () => process.env.HOST || '127.0.0.1',
  // عدد الوسطاء الموثوقين (نفق Cloudflare / Nginx ...). 0 = لا وسيط
  trustProxy: () => {
    const v = process.env.TRUST_PROXY;
    if (v === undefined || v === '') return 0;
    return /^\d+$/.test(v) ? parseInt(v) : bool(v);
  },
  // نطاقات CORS المسموحة (مفصولة بفواصل). فارغ = نفس الأصل فقط
  corsOrigins: () => (process.env.CORS_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean),
  bcryptRounds: () => Math.min(14, Math.max(10, parseInt(process.env.BCRYPT_ROUNDS) || 10)),
  jwtExpiry: () => process.env.JWT_EXPIRY || '12h',
  bool
};
