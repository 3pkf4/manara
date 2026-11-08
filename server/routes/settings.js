/** إعدادات المتجر القابلة للتعديل (مدير المتجر). مُركَّب على /api/settings */
const express = require('express');
const router = express.Router();
const { query } = require('../db');
const { authenticate, requireRole, checkTenantActive, requireTenant } = require('../middleware/auth');
const { logActivity } = require('../middleware/logger');
const { HttpError, num, getSettings, truthy } = require('../lib/util');

router.use(authenticate, checkTenantActive, requireTenant);

// المفاتيح المسموحة + مُحقِّق/مُطبِّع لكل مفتاح + القيمة الافتراضية
const SCHEMA = {
  loyalty_enabled:            { def: 'false', parse: v => String(truthy(v)) },
  loyalty_spend_per_point:    { def: '10',    parse: v => String(num(v, { name: 'الإنفاق لكل نقطة', min: 0.01, max: 1e6 })) },
  loyalty_redeem_value:       { def: '0.1',   parse: v => String(num(v, { name: 'قيمة النقطة', min: 0.001, max: 1000 })) },
  cashier_max_discount_percent: { def: '10',  parse: v => String(num(v, { name: 'حد خصم الكاشير', min: 0, max: 100 })) },
  require_shift:              { def: 'false', parse: v => String(truthy(v)) },
  print_footer:               { def: 'شكراً لزيارتكم', parse: v => String(v).slice(0, 200) }
};

router.get('/', async (req, res, next) => {
  try {
    const cur = await getSettings({ query }, req.tenantId);
    const out = {};
    for (const [k, d] of Object.entries(SCHEMA)) out[k] = cur[k] !== undefined ? cur[k] : d.def;
    res.json({ ok: true, data: out });
  } catch (e) { next(e); }
});

router.put('/', requireRole('tenant_admin'), async (req, res, next) => {
  try {
    const b = req.body || {};
    const changed = [];
    for (const [k, v] of Object.entries(b)) {
      if (!SCHEMA[k]) throw new HttpError(400, `إعداد غير معروف: ${k}`);
      const val = SCHEMA[k].parse(v);
      await query(
        `INSERT INTO tenant_settings (tenant_id, setting_key, setting_value) VALUES ($1,$2,$3)
         ON CONFLICT (tenant_id, setting_key) DO UPDATE SET setting_value = EXCLUDED.setting_value, updated_at = NOW()`,
        [req.tenantId, k, val]);
      changed.push(k);
    }
    if (!changed.length) throw new HttpError(400, 'لا توجد إعدادات');
    await logActivity(req, 'update_settings', 'settings', null, { keys: changed });
    res.json({ ok: true, changed });
  } catch (e) { next(e); }
});

module.exports = router;
