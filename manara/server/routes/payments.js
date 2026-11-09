/**
 * الدفع الإلكتروني للاشتراك عبر MyPay.
 * - السعر والمدة يحددهما الخادم (جدول plan_prices) لا المتصفح.
 * - لا يُفعَّل الاشتراك إلا من إشعار Webhook موقَّع ومطابق للطلب (المبلغ والعملة)، وبمرة واحدة فقط.
 * - صفحة العودة (return_url) للعرض فقط ولا تفعّل شيئاً.
 */
const express = require('express');
const router = express.Router();
const { query, transaction } = require('../db');
const { authenticate, requireRole, checkUser, requireTenant } = require('../middleware/auth');
const { PLANS, extendSubscription } = require('../lib/license');
const mypay = require('../lib/mypay');
const { HttpError, num } = require('../lib/util');

const SELLABLE = ['WEEK', 'MONTH', 'YEAR'];

// ---------------- Webhook (عام، موقَّع) ----------------
router.post('/webhook', async (req, res, next) => {
  try {
    const c = mypay.cfg();
    if (!c.webhookSecret) return res.status(503).json({ ok: false, error: 'غير مُهيّأ' });
    if (!mypay.verifySignature(req.rawBody, req.get('X-MyPay-Signature'), c.webhookSecret)) {
      return res.status(401).json({ ok: false, error: 'توقيع غير صالح' });
    }
    const ev = req.body || {};
    const token = String(ev.token || ev.transaction_id || '');
    if (!token) return res.json({ ok: true, ignored: 'no_token' });

    const out = await transaction(async (client) => {
      const o = (await client.query('SELECT * FROM payment_orders WHERE mypay_token = $1 FOR UPDATE', [token])).rows[0];
      if (!o) return { ignored: 'unknown_order' };
      if (o.status === 'paid') return { duplicate: true };
      if (o.status === 'mismatch') return { ignored: 'already_flagged' };

      const success = ev.event === 'payment.success' && String(ev.status || '').toLowerCase() === 'success';
      if (!success) {
        await client.query(`UPDATE payment_orders SET status = 'failed', last_event = $2 WHERE id = $1`, [o.id, ev]);
        return { status: 'failed' };
      }
      const amountOk = Math.abs(parseFloat(ev.amount) - parseFloat(o.amount)) < 0.005;
      const currencyOk = String(ev.currency || '').toUpperCase() === o.currency;
      const txId = String(ev.transaction_id || '') || null;
      let txTaken = false;
      if (txId) txTaken = (await client.query('SELECT 1 FROM payment_orders WHERE transaction_id = $1 AND id <> $2', [txId, o.id])).rows.length > 0;
      if (!amountOk || !currencyOk || txTaken) {
        await client.query(`UPDATE payment_orders SET status = 'mismatch', last_event = $2 WHERE id = $1`, [o.id, ev]);
        console.error('⚠️ MyPay mismatch للطلب', o.id, { amountOk, currencyOk, txTaken });
        return { status: 'mismatch' };
      }
      await client.query(
        `UPDATE payment_orders SET status = 'paid', paid_at = NOW(), transaction_id = $2, trx_ref = $3, gateway = $4, last_event = $5 WHERE id = $1`,
        [o.id, txId, ev.trx_ref ? String(ev.trx_ref) : null, ev.gateway ? String(ev.gateway) : null, ev]);
      const end = await extendSubscription(client, o.tenant_id, o.duration_minutes);
      console.log('✅ دفع MyPay: تمديد اشتراك', o.tenant_id, o.plan, '→', end);
      return { status: 'paid' };
    });
    res.json({ ok: true, ...out });
  } catch (e) { next(e); } // 500 ⇒ ستعيد MyPay المحاولة
});

// ---------------- بدء الدفع (مشترك) ----------------
async function startCheckout({ tenantId, plan, userId = null, fullName = null, phone = null }) {
  if (!mypay.configured()) throw new HttpError(503, 'الدفع الإلكتروني غير مفعّل بعد');
  if (!SELLABLE.includes(plan)) throw new HttpError(400, 'باقة غير صالحة');
  const p = (await query('SELECT price FROM plan_prices WHERE plan = $1 AND is_active', [plan])).rows[0];
  if (!p) throw new HttpError(400, 'هذه الباقة غير متاحة للدفع الإلكتروني حالياً');
  const recent = (await query(
    `SELECT COUNT(*)::int n FROM payment_orders WHERE tenant_id = $1 AND status = 'pending' AND created_at > NOW() - INTERVAL '1 hour'`, [tenantId])).rows[0].n;
  if (recent >= 10) throw new HttpError(429, 'طلبات دفع كثيرة غير مكتملة، حاول بعد قليل');
  const o = (await query(
    `INSERT INTO payment_orders (tenant_id, plan, amount, duration_minutes, created_by) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
    [tenantId, plan, p.price, PLANS[plan].minutes, userId])).rows[0];
  try {
    const pay = await mypay.createPayment({ amount: p.price, orderId: o.id, fullName, phone });
    await query('UPDATE payment_orders SET mypay_token = $2 WHERE id = $1', [o.id, pay.token]);
    return { payment_url: pay.payment_url, order_id: o.id };
  } catch (e) {
    await query(`UPDATE payment_orders SET status = 'failed' WHERE id = $1`, [o.id]);
    throw e;
  }
}

async function resolveTenantId(code) {
  if (code) {
    const t = await query('SELECT id FROM tenants WHERE UPPER(tenant_code) = $1', [String(code).trim().toUpperCase()]);
    return t.rows.length ? t.rows[0].id : null;
  }
  const all = await query('SELECT id FROM tenants LIMIT 2');
  return all.rows.length === 1 ? all.rows[0].id : null;
}

// ---------------- مسارات عامة: المتجر منتهي الاشتراك لا يستطيع تسجيل الدخول، فيجدّد برمز المتجر ----------------
// (دفع اشتراك متجر آخر لا يضر أحداً؛ التفعيل يتم فقط بإشعار MyPay الموقَّع)
router.get('/public-plans', async (req, res, next) => {
  try {
    const enabled = mypay.configured();
    const r = enabled ? await query('SELECT plan, price FROM plan_prices WHERE is_active AND plan = ANY($1)', [SELLABLE]) : { rows: [] };
    res.json({ ok: true, enabled, whatsapp: (process.env.SUPPORT_WHATSAPP || '218922227299').replace(/\D/g, ''), data: r.rows.map(x => ({ plan: x.plan, name: PLANS[x.plan].name, price: parseFloat(x.price), currency: 'LYD' })) });
  } catch (e) { next(e); }
});
router.post('/renew', async (req, res, next) => {
  try {
    const { tenant_code, plan } = req.body || {};
    const tenantId = await resolveTenantId(tenant_code);
    if (!tenantId) throw new HttpError(400, 'أدخل رمز المتجر', 'TENANT_CODE_REQUIRED');
    res.json({ ok: true, ...(await startCheckout({ tenantId, plan: String(plan || '') })) });
  } catch (e) { next(e); }
});
router.get('/public-status', async (req, res, next) => {
  try {
    const t = String(req.query.token || '').slice(0, 120);
    if (!t) return res.json({ ok: true, order: null });
    const r = await query(
      `SELECT o.status, o.plan, o.paid_at, o.id, t.subscription_end FROM payment_orders o JOIN tenants t ON t.id = o.tenant_id WHERE o.mypay_token = $1`, [t]);
    const o = r.rows[0];
    res.json({ ok: true, order: o ? { status: o.status, plan: o.plan, paid_at: o.paid_at, id: o.id } : null, subscription_end: o ? o.subscription_end : null });
  } catch (e) { next(e); }
});

// ---------------- بقية المسارات تتطلب تسجيل دخول ----------------
router.use(authenticate, checkUser);

// المالك: أسعار الباقات
router.get('/plan-prices', requireRole('owner'), async (req, res, next) => {
  try {
    const r = await query('SELECT plan, price, is_active FROM plan_prices');
    const m = Object.fromEntries(r.rows.map(x => [x.plan, x]));
    res.json({ ok: true, configured: mypay.configured(), data: SELLABLE.map(p => ({ plan: p, name: PLANS[p].name, price: m[p] ? parseFloat(m[p].price) : null, is_active: m[p] ? m[p].is_active : false })) });
  } catch (e) { next(e); }
});
router.put('/plan-prices', requireRole('owner'), async (req, res, next) => {
  try {
    const { plan, is_active } = req.body || {};
    if (!SELLABLE.includes(plan)) throw new HttpError(400, 'باقة غير قابلة للبيع الإلكتروني');
    const price = num(req.body.price, { name: 'السعر', min: 0.01, max: 1e7 });
    const r = await query(
      `INSERT INTO plan_prices (plan, price, is_active) VALUES ($1,$2,$3)
       ON CONFLICT (plan) DO UPDATE SET price = EXCLUDED.price, is_active = EXCLUDED.is_active, updated_at = NOW() RETURNING *`,
      [plan, price, is_active !== false]);
    res.json({ ok: true, data: r.rows[0] });
  } catch (e) { next(e); }
});

router.use(requireTenant);

// الباقات المتاحة للدفع الإلكتروني
router.get('/plans', async (req, res, next) => {
  try {
    const r = await query('SELECT plan, price FROM plan_prices WHERE is_active AND plan = ANY($1)', [SELLABLE]);
    const enabled = mypay.configured();
    res.json({ ok: true, enabled, data: enabled ? r.rows.map(x => ({ plan: x.plan, name: PLANS[x.plan].name, price: parseFloat(x.price), currency: 'LYD' })) : [] });
  } catch (e) { next(e); }
});

// بدء الدفع (مدير المتجر فقط)
router.post('/checkout', requireRole('tenant_admin'), async (req, res, next) => {
  try {
    const u = (await query('SELECT full_name, phone FROM users WHERE id = $1', [req.user.id])).rows[0] || {};
    res.json({ ok: true, ...(await startCheckout({ tenantId: req.tenantId, plan: String((req.body || {}).plan || ''), userId: req.user.id, fullName: u.full_name, phone: u.phone })) });
  } catch (e) { next(e); }
});

// حالة طلب (لصفحة العودة): بالرمز الذي تعيده MyPay أو بمعرّف الطلب
router.get('/status', async (req, res, next) => {
  try {
    const t = String(req.query.token || '').slice(0, 120);
    const r = t
      ? await query('SELECT id, plan, amount, status, paid_at FROM payment_orders WHERE tenant_id = $1 AND mypay_token = $2', [req.tenantId, t])
      : await query('SELECT id, plan, amount, status, paid_at FROM payment_orders WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT 1', [req.tenantId]);
    const s = (await query('SELECT subscription_end FROM tenants WHERE id = $1', [req.tenantId])).rows[0];
    res.json({ ok: true, order: r.rows[0] || null, subscription_end: s && s.subscription_end });
  } catch (e) { next(e); }
});

router.get('/orders', requireRole('tenant_admin'), async (req, res, next) => {
  try {
    const r = await query(
      `SELECT id, plan, amount, currency, status, gateway, created_at, paid_at FROM payment_orders WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT 100`, [req.tenantId]);
    res.json({ ok: true, data: r.rows });
  } catch (e) { next(e); }
});

module.exports = router;
