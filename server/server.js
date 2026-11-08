const config = require('./lib/config'); // يحمّل .env أيضاً
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const morgan = require('morgan');
const path = require('path');
const rateLimit = require('express-rate-limit');

const { query, pool, testConnection } = require('./db');
const { errorHandler, notFound } = require('./middleware/errors');

function limiter(windowMs, max, message) {
  return rateLimit({
    windowMs, max,
    standardHeaders: true, legacyHeaders: false,
    message: { ok: false, error: message, code: 'RATE_LIMITED' }
  });
}

function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxy());

  // ---------- الأمان ----------
  app.use(helmet({
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: ["'self'"],
        // الواجهة الحالية تستخدم onclick مضمّنة؛ ننصح بإزالتها تدريجياً ثم حذف unsafe-inline
        scriptSrc: ["'self'", "'unsafe-inline'", 'https://cdn.jsdelivr.net'],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:', 'blob:'],
        fontSrc: ["'self'", 'data:'],
        connectSrc: ["'self'"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"]
      }
    },
    crossOriginEmbedderPolicy: false,
    hsts: config.isProd() ? { maxAge: 15552000 } : false
  }));
  app.use(compression());

  const origins = config.corsOrigins();
  if (origins.length) {
    app.use(cors({ origin: origins, credentials: false }));
  } // بدون CORS_ORIGINS: نفس الأصل فقط

  app.use('/api/data/import', express.json({ limit: '5mb' }));
  // نحتفظ بالجسم الخام لإشعارات MyPay: التوقيع (HMAC) يُحسب عليه بالحرف
  app.use(express.json({ limit: '1mb', verify: (req, res, buf) => { if (req.originalUrl.startsWith('/api/payments/webhook')) req.rawBody = buf; } }));
  app.use(express.urlencoded({ extended: false, limit: '100kb' }));

  if (process.env.NODE_ENV !== 'test') {
    app.use(morgan('combined', { skip: (req) => req.url === '/health' }));
  }

  // ---------- تحديد المعدّل ----------
  if (process.env.NODE_ENV !== 'test') {
    app.use('/api/', limiter(60 * 1000, 300, 'عدد الطلبات كبير جداً'));
    app.use('/api/auth/login', limiter(15 * 60 * 1000, 30, 'محاولات دخول كثيرة. حاول بعد 15 دقيقة'));
    app.use('/api/subscription/activate', limiter(15 * 60 * 1000, 10, 'محاولات تفعيل كثيرة. حاول لاحقاً'));
    app.use('/api/setup', limiter(15 * 60 * 1000, 30, 'محاولات كثيرة'));
    app.use('/api/qr/redeem', limiter(15 * 60 * 1000, 30, 'محاولات كثيرة. حاول بعد 15 دقيقة'));
    app.use('/api/ops', limiter(60 * 1000, 120, 'طلبات كثيرة'));
    app.use('/api/payments/renew', limiter(15 * 60 * 1000, 10, 'محاولات دفع كثيرة. حاول لاحقاً'));
  }

  // ---------- فحص الصحة ----------
  app.get('/health', async (req, res) => {
    let db = true;
    if (req.query.deep !== undefined) db = await query('SELECT 1').then(() => true).catch(() => false);
    res.status(db ? 200 : 503).json({ ok: db, service: 'manara-pos', version: require('../package.json').version });
  });

  // ---------- التوجيه لصفحة الإعداد قبل أول تهيئة ----------
  app.get('/', async (req, res, next) => {
    try {
      const r = await query('SELECT is_completed FROM system_setup WHERE id = 1');
      if (!r.rows.length || !r.rows[0].is_completed) return res.redirect('/setup.html');
    } catch (e) { /* نتابع */ }
    next();
  });

  // ---------- API ----------
  app.use('/api/setup', require('./routes/setup'));
  app.use('/api/auth', require('./routes/auth'));
  app.use('/api/products', require('./routes/products'));
  app.use('/api/customers', require('./routes/customers'));
  app.use('/api/sales', require('./routes/sales'));
  app.use('/api/suppliers', require('./routes/suppliers'));
  app.use('/api/purchases', require('./routes/purchases'));
  app.use('/api/expenses', require('./routes/expenses'));
  app.use('/api/returns', require('./routes/returns'));
  app.use('/api/reports', require('./routes/reports'));
  app.use('/api/users', require('./routes/users'));
  app.use('/api/admin', require('./routes/admin'));
  app.use('/api/branches', require('./routes/branches'));
  app.use('/api/subscription', require('./routes/license'));        // عام (تفعيل بكود)
  app.use('/api/subscriptions', require('./routes/subscriptions')); // خاص بالمتجر المسجَّل
  app.use('/api/public-url', require('./routes/public-url'));
  app.use('/api/shifts', require('./routes/shifts'));
  app.use('/api/export', require('./routes/export'));
  app.use('/api/data', require('./routes/data'));
  app.use('/api/inventory', require('./routes/inventory'));
  app.use('/api/promotions', require('./routes/promotions'));
  app.use('/api/payments', require('./routes/payments'));
  app.use('/api/ops', require('./routes/ops'));
  app.use('/api/qr', require('./routes/qrlogin'));
  app.use('/api/alerts', require('./routes/alerts'));
  app.use('/api/settings', require('./routes/settings'));
  app.use('/api', (req, res) => res.status(404).json({ ok: false, error: 'المسار غير موجود' }));

  // ---------- الملفات الثابتة ----------
  const publicPath = path.join(__dirname, '../public');

  // لا نخدم نسخاً احتياطية أو ملفات حساسة حتى لو وُجدت بالخطأ داخل public/
  app.use((req, res, next) => {
    if (/\.(backup|bak|broken|old|orig|sql|env|log|map)(\b|[-.\d]|$)/i.test(req.path) ||
        /\/\.(?!well-known)/.test(req.path)) {
      return res.status(404).end();
    }
    next();
  });

  app.get('/service-worker.js', (req, res) => {
    res.setHeader('Content-Type', 'application/javascript');
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Service-Worker-Allowed', '/');
    res.sendFile(path.join(publicPath, 'service-worker.js'));
  });
  app.get('/manifest.json', (req, res) => {
    res.setHeader('Content-Type', 'application/manifest+json');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.sendFile(path.join(publicPath, 'manifest.json'));
  });
  app.use(express.static(publicPath, { maxAge: '1h', etag: true, dotfiles: 'deny', index: ['index.html'] }));

  // SPA fallback
  app.get('*', (req, res) => res.sendFile(path.join(publicPath, 'index.html')));

  app.use(notFound);
  app.use(errorHandler);
  return app;
}

async function start() {
  config.validateEnv();
  console.log('\n🏪 المنارة POS & ERP\n');

  if (!(await testConnection())) {
    console.error('❌ لا يمكن تشغيل الخادم بدون قاعدة بيانات');
    process.exit(1);
  }
  if (config.bool(process.env.AUTO_MIGRATE, true)) {
    const { migrate } = require('./database/migrate');
    await migrate(pool, () => {});
  }
  await require('./lib/bootstrap').ensureOwner(pool);

  const app = createApp();
  const server = app.listen(config.port(), config.host(), () => {
    console.log(`✅ الخادم يعمل: http://${config.host()}:${config.port()}  (${process.env.NODE_ENV || 'development'})`);
  });

  let closing = false;
  const shutdown = (sig) => {
    if (closing) return;
    closing = true;
    console.log(`\n⏹️  إغلاق آمن (${sig})...`);
    server.close(async () => { await pool.end().catch(() => {}); process.exit(0); });
    setTimeout(() => process.exit(1), 10000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('unhandledRejection', (err) => console.error('❌ Unhandled rejection:', err));
}

module.exports = { createApp };

if (require.main === module) {
  start().catch(e => { console.error(e.message || e); process.exit(1); });
}
