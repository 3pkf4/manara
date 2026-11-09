/**
 * مسارات الترخيص العامة (تُستخدم قبل تسجيل الدخول، مثلاً عند انتهاء الاشتراك).
 * مُركَّبة على /api/subscription
 */
const express = require('express');
const router = express.Router();
const { query, transaction } = require('../db');
const { redeemCode, hashCode, normalizeCode, PLANS } = require('../lib/license');
const { HttpError } = require('../lib/util');
const { logActivity } = require('../middleware/logger');

/** يحدّد المتجر المقصود: بالكود المربوط، أو tenant_code، أو المتجر الوحيد في التثبيت */
async function resolveTenant({ tenantCode, codeHash }) {
  if (codeHash) {
    const b = await query(
      'SELECT tenant_id FROM license_codes WHERE code_hash = $1 AND used_at IS NULL AND revoked_at IS NULL', [codeHash]);
    if (b.rows.length && b.rows[0].tenant_id) return b.rows[0].tenant_id;
  }
  if (tenantCode) {
    const t = await query('SELECT id FROM tenants WHERE UPPER(tenant_code) = $1', [String(tenantCode).trim().toUpperCase()]);
    return t.rows.length ? t.rows[0].id : null;
  }
  const all = await query('SELECT id FROM tenants LIMIT 2');
  return all.rows.length === 1 ? all.rows[0].id : null;
}

// حالة الاشتراك (بدون بيانات حساسة)
router.get('/status', async (req, res, next) => {
  try {
    const tenantId = await resolveTenant({ tenantCode: req.query.tenant_code });
    if (!tenantId) return res.json({ active: false, plan: 'none', serverTime: Date.now() });
    const r = await query(
      `SELECT subscription_status, subscription_end, plan, is_suspended, is_active
         FROM tenants WHERE id = $1`, [tenantId]);
    const t = r.rows[0];
    const end = t.subscription_end ? new Date(t.subscription_end) : null;
    const active = !!(end && end > new Date() && t.subscription_status === 'active' && t.is_active && !t.is_suspended);
    res.json({
      active,
      endDate: end ? end.toISOString() : null,
      plan: t.plan,
      plan_name: t.plan,
      serverTime: Date.now()
    });
  } catch (e) { next(e); }
});

// تفعيل كود (لمرة واحدة). محدود المعدّل في server.js
router.post('/activate', async (req, res, next) => {
  try {
    const { code, tenant_code } = req.body || {};
    if (typeof code !== 'string' || !code.trim()) throw new HttpError(400, 'الرجاء إدخال الكود');
    if (normalizeCode(code).length < 16) throw new HttpError(400, 'كود غير صالح');

    const tenantId = await resolveTenant({ tenantCode: tenant_code, codeHash: hashCode(code) });
    if (!tenantId) {
      throw new HttpError(400, 'أدخل رمز المتجر (tenant_code) لتفعيل الكود', 'TENANT_CODE_REQUIRED');
    }
    const result = await transaction(client => redeemCode(client, { code, tenantId }));
    req.tenantId = tenantId;
    console.log('✅ تفعيل اشتراك:', result.plan_name, '— ينتهي:', result.subscription_end);
    res.json({
      success: true,
      ok: true,
      message: 'تم التفعيل بنجاح! ' + result.plan_name,
      license: {
        plan: result.plan, plan_name: result.plan_name,
        endDate: new Date(result.subscription_end).toISOString(), is_active: true
      }
    });
  } catch (e) { next(e); }
});

router.get('/plans', (req, res) => {
  res.json({ ok: true, data: Object.entries(PLANS).map(([k, v]) => ({ key: k, name: v.name, minutes: v.minutes })) });
});

module.exports = router;
