const { HttpError } = require('../lib/util');

// معالج أخطاء موحد
function errorHandler(err, req, res, next) {
  if (res.headersSent) return next(err);

  // أخطاء عميل متوقعة (HttpError أو أخطاء body-parser)
  if (err instanceof HttpError || err.expose || err.type === 'entity.too.large' || err.type === 'entity.parse.failed') {
    const status = err.status || 400;
    return res.status(status).json({
      ok: false,
      error: err.type === 'entity.too.large' ? 'حجم الطلب كبير جداً'
           : err.type === 'entity.parse.failed' ? 'صيغة JSON غير صحيحة'
           : err.message,
      ...(err.code && typeof err.code === 'string' && !/^\d/.test(err.code) ? { code: err.code } : {})
    });
  }

  console.error('❌ خطأ:', req.method, req.originalUrl, '-', err.message);
  if (process.env.NODE_ENV !== 'production') console.error(err.stack);

  // أخطاء قاعدة البيانات
  if (err.code === '23505') {
    const msgs = { uq_products_plu: 'رمز الميزان (PLU) مستخدم لمنتج آخر في هذا الفرع', uq_product_barcodes: 'هذا الباركود مستخدم مسبقاً' };
    return res.status(409).json({ ok: false, error: msgs[err.constraint] || 'عنصر مكرر' });
  }
  if (err.code === '23503') return res.status(400).json({ ok: false, error: 'مرجع غير موجود أو مستخدم في بيانات أخرى' });
  if (err.code === '22P02' || err.code === '22003' || err.code === '22007') return res.status(400).json({ ok: false, error: 'قيمة غير صالحة' });
  if (err.code === '23514') return res.status(400).json({ ok: false, error: 'القيمة مخالفة لقيود النظام' });

  // لا نكشف تفاصيل الأخطاء الداخلية للعميل
  res.status(500).json({ ok: false, error: 'خطأ داخلي في الخادم' });
}

function notFound(req, res) {
  res.status(404).json({ ok: false, error: 'المسار غير موجود' });
}

// مساعد للتحقق من وجود الحقول
function validateRequired(body, fields) {
  const missing = fields.filter(f => body[f] === undefined || body[f] === null || body[f] === '');
  if (missing.length) throw new HttpError(400, 'حقول مطلوبة مفقودة: ' + missing.join(', '));
}

module.exports = { errorHandler, notFound, validateRequired };
