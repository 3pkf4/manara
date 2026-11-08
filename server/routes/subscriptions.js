/** اشتراك المتجر الحالي (يتطلب تسجيل دخول). مُركَّب على /api/subscriptions */
const express = require('express');
const router = express.Router();
const { query, transaction } = require('../db');
const { authenticate, requireRole, checkUser, requireTenant } = require('../middleware/auth');
const { redeemCode } = require('../lib/license');
const { logActivity } = require('../middleware/logger');
const { HttpError } = require('../lib/util');

router.use(authenticate, checkUser, requireTenant);

// تفعيل كود لمتجر المستخدم الحالي (مدير المتجر فقط)
router.post('/activate-code', requireRole('tenant_admin'), async (req, res, next) => {
  try {
    const { code } = req.body || {};
    if (typeof code !== 'string' || !code.trim()) throw new HttpError(400, 'الرجاء إدخال كود التفعيل');
    const result = await transaction(client => redeemCode(client, { code, tenantId: req.tenantId }));
    await logActivity(req, 'redeem_license', 'tenant', req.tenantId, { plan: result.plan });
    res.json({
      ok: true,
      message: 'تم تفعيل الاشتراك بنجاح!',
      plan_name: result.plan_name,
      new_expiry: result.subscription_end
    });
  } catch (e) { next(e); }
});

router.get('/status', async (req, res, next) => {
  try {
    const r = await query(
      `SELECT subscription_status, subscription_end, business_name, plan, is_trial
         FROM tenants WHERE id = $1`, [req.tenantId]);
    if (!r.rows.length) return res.json({ active: false, endDate: null });
    const t = r.rows[0];
    const active = t.subscription_status === 'active' && t.subscription_end && new Date(t.subscription_end) > new Date();
    res.json({
      active: !!active, status: t.subscription_status, endDate: t.subscription_end,
      business_name: t.business_name, plan: t.plan, is_trial: t.is_trial
    });
  } catch (e) { next(e); }
});

module.exports = router;
