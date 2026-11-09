/**
 * عميل MyPay (https://docs.mypay.ly). الإعدادات تُقرأ من البيئة عند كل استدعاء.
 * المفاتيح تبقى على الخادم فقط ولا تصل للمتصفح أبداً.
 */
const crypto = require('crypto');
const { HttpError } = require('./util');

function cfg() {
  return {
    base: (process.env.MYPAY_BASE_URL || 'https://mypay.ly/pay/sandbox/api/v1').replace(/\/+$/, ''),
    id: process.env.MYPAY_CLIENT_ID || '',
    secret: process.env.MYPAY_CLIENT_SECRET || '',
    webhookSecret: process.env.MYPAY_WEBHOOK_SECRET || '',
    publicUrl: (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '')
  };
}
// قيم قصيرة أو وهمية (مثل «-») لا تُعدّ إعداداً صالحاً، و PUBLIC_BASE_URL يجب أن يكون https
const configured = () => { const c = cfg(); return c.id.length > 3 && c.secret.length > 3 && c.webhookSecret.length > 3 && /^https:\/\/[^/\s]+/.test(c.publicUrl); };

async function call(path, body, token) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 15000);
  try {
    const res = await fetch(cfg().base + path, {
      method: 'POST', signal: ctl.signal,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
      body: JSON.stringify(body)
    });
    const json = await res.json().catch(() => ({}));
    return { status: res.status, json };
  } catch (e) {
    throw new HttpError(502, 'تعذر الاتصال ببوابة الدفع، حاول لاحقاً');
  } finally { clearTimeout(timer); }
}

// الرمز صالح 600 ثانية: نُخزّنه ونجدده قبل انتهائه بدقيقة
let cached = null;
async function getToken() {
  if (cached && cached.exp > Date.now()) return cached.token;
  const c = cfg();
  const r = await call('/authentication/token', { client_id: c.id, secret_id: c.secret });
  const d = r.json && r.json.data;
  if (!(r.json && r.json.type === 'success' && d && d.access_token)) {
    console.error('MyPay auth failed:', r.status, JSON.stringify(r.json).slice(0, 300));
    throw new HttpError(502, 'فشل الاتصال ببوابة الدفع');
  }
  cached = { token: d.access_token, exp: Date.now() + Math.max(60, (d.expire_time || 600) - 60) * 1000 };
  return cached.token;
}
function resetTokenCache() { cached = null; }

/** ينشئ عملية دفع ويعيد { token, payment_url } */
async function createPayment({ amount, orderId, fullName, phone, email }) {
  const c = cfg();
  const body = {
    amount: Number(amount).toFixed(2), currency: 'LYD',
    return_url: c.publicUrl + '/pay-result.html', cancel_url: c.publicUrl + '/pay-result.html',
    custom: String(orderId)
  };
  if (fullName) body.full_name = fullName;
  if (phone) body.phone = phone;
  if (email) body.email = email;
  let r = await call('/payment/create', body, await getToken());
  if (r.status === 401) { resetTokenCache(); r = await call('/payment/create', body, await getToken()); }
  const d = r.json && r.json.data;
  if (!(r.json && r.json.type === 'success' && d && d.payment_url && d.token)) {
    console.error('MyPay create failed:', r.status, JSON.stringify(r.json).slice(0, 300));
    throw new HttpError(502, 'تعذر إنشاء عملية الدفع');
  }
  return { token: String(d.token), payment_url: String(d.payment_url) };
}

/** يتحقق من توقيع HMAC-SHA256 للجسم الخام (يقبل hex أو base64، مع بادئة sha256= اختيارية) */
function verifySignature(raw, signature, secret) {
  if (!raw || !signature || !secret) return false;
  const sig = String(signature).trim().replace(/^sha256=/i, '');
  const mac = crypto.createHmac('sha256', secret).update(raw).digest();
  const candidates = [Buffer.from(mac.toString('hex')), Buffer.from(mac.toString('base64'))];
  const given = Buffer.from(/^[0-9a-f]+$/i.test(sig) ? sig.toLowerCase() : sig);
  return candidates.some(c => c.length === given.length && crypto.timingSafeEqual(c, given));
}

module.exports = { cfg, configured, createPayment, verifySignature, resetTokenCache };
