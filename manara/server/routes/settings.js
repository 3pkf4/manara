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
  print_footer:               { def: 'شكراً لزيارتكم', parse: v => String(v).slice(0, 200) },
  // هوية المتجر: لون رئيسي، شعار (صورة صغيرة مضغوطة)، سطر ترويسة للفاتورة
  brand_color:                { def: '', parse: v => { v = String(v || '').trim(); if (v && !/^#[0-9a-fA-F]{6}$/.test(v)) throw new HttpError(400, 'اللون غير صالح'); return v.toLowerCase(); } },
  brand_logo:                 { def: '', parse: v => { v = String(v || ''); if (v && (v.length > 150000 || !/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(v))) throw new HttpError(400, 'الشعار غير صالح (png/jpg/webp وحجم صغير)'); return v; } },
  receipt_header:             { def: '', parse: v => String(v || '').slice(0, 200) }
};

// هوية المتجر لكل المستخدمين (تُطبَّق على الشاشة والفاتورة)
router.get('/brand', async (req, res, next) => {
  try {
    const cur = await getSettings({ query }, req.tenantId);
    const t = await query('SELECT business_name, address, owner_phone FROM tenants WHERE id = $1', [req.tenantId]);
    const r = t.rows[0] || {};
    res.json({ ok: true, data: {
      name: r.business_name || '', address: r.address || '', phone: r.owner_phone || '',
      color: cur.brand_color || '', logo: cur.brand_logo || '', header: cur.receipt_header || '',
      footer: cur.print_footer !== undefined ? cur.print_footer : 'شكراً لزيارتكم' } });
  } catch (e) { next(e); }
});

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
