#!/usr/bin/env node
/** فحص جاهزية الإنتاج: node scripts/preflight.js  (يقرأ .env أو متغيرات البيئة). يخرج برمز 1 عند وجود أخطاء. */
require('../server/lib/config');
const e = process.env, bad = [], warn = [];
const isUrl = (v) => /^https:\/\/[^/\s]+/.test(v || '');
if (e.NODE_ENV !== 'production') bad.push('NODE_ENV يجب أن يكون production');
if (!e.DATABASE_URL && !(e.DB_HOST && e.DB_NAME && e.DB_USER && e.DB_PASSWORD)) bad.push('إعدادات قاعدة البيانات ناقصة (DATABASE_URL أو DB_*)');
if ((e.JWT_SECRET || '').length < 32) bad.push('JWT_SECRET أقل من 32 حرفاً');
if (e.HOST !== '0.0.0.0' && e.HOST !== '::' && !e.HOST) warn.push('HOST غير مضبوط: على الاستضافات السحابية اضبطه 0.0.0.0');
if (!e.TRUST_PROXY || e.TRUST_PROXY === '0') warn.push('TRUST_PROXY=1 مطلوب خلف وسيط HTTPS (وإلا تُحسب كل الطلبات من IP واحد ويتعطل تحديد المعدل)');
if (e.AUTO_MIGRATE === 'false') warn.push('AUTO_MIGRATE=false: تأكد من تشغيل الهجرات يدوياً عند كل تحديث');
if (e.SEED_DEMO === 'true') bad.push('SEED_DEMO=true ممنوع في الإنتاج');
const pay = ['MYPAY_CLIENT_ID', 'MYPAY_CLIENT_SECRET', 'MYPAY_WEBHOOK_SECRET'].filter(k => !e[k]);
if (pay.length && pay.length < 3) bad.push('إعداد MyPay ناقص: ' + pay.join(', '));
if (pay.length === 3) warn.push('الدفع الإلكتروني غير مفعّل (MyPay غير مضبوط) — الأكواد اليدوية فقط');
else {
  if (!isUrl(e.PUBLIC_BASE_URL)) bad.push('PUBLIC_BASE_URL يجب أن يكون رابط https كامل');
  if (/sandbox/.test(e.MYPAY_BASE_URL || 'sandbox')) warn.push('MYPAY_BASE_URL يشير إلى Sandbox: بدّله إلى https://mypay.ly/pay/api/v1 لقبول دفع حقيقي');
}
if (e.OPS_API_KEY && e.OPS_API_KEY.length < 32) bad.push('OPS_API_KEY أقل من 32 حرفاً');
if (!e.OPS_API_KEY) warn.push('OPS_API_KEY غير مضبوط: لوحة الدعم (Apps Script) معطلة');
if (e.OWNER_PASSWORD) warn.push('OWNER_PASSWORD ما زال مضبوطاً: احذفه بعد إنشاء حساب المالك وتغيير كلمته');
if (!e.CORS_ORIGINS) warn.push('CORS_ORIGINS فارغ (نفس الأصل فقط) — هذا الوضع الصحيح لتطبيق واحد');
bad.forEach(m => console.log('❌ ' + m)); warn.forEach(m => console.log('⚠️  ' + m));
if (!bad.length) console.log('✅ لا أخطاء مانعة' + (warn.length ? ` (${warn.length} تنبيه)` : ''));
process.exit(bad.length ? 1 : 0);
