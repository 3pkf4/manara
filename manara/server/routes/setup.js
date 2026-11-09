const express = require('express');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { signToken } = require('../middleware/auth');
const { checkPasswordStrength } = require('../lib/password');
const { HttpError } = require('../lib/util');
const { bcryptRounds } = require('../lib/config');
const { v4: uuidv4 } = require('uuid');
const router = express.Router();

function tokenEquals(a, b) {
  const x = Buffer.from(String(a || '')), y = Buffer.from(String(b || ''));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
const { query, transaction } = require('../db');

// ============================================
// حالة الإعداد
// ============================================
router.get('/status', async (req, res, next) => {
  try {
    const r = await query('SELECT is_completed FROM system_setup WHERE id = 1');
    res.json({
      ok: true,
      completed: r.rows[0]?.is_completed === true
    });
  } catch (e) { next(e); }
});

// ============================================
// التحقق من Setup Token
// ============================================
router.post('/verify-token', async (req, res, next) => {
  try {
    const { token } = req.body;
    if (!token) return res.status(400).json({ ok: false, error: 'الرمز مطلوب' });

    const r = await query(
      'SELECT setup_token, is_completed FROM system_setup WHERE id = 1'
    );
    if (!r.rows.length) return res.status(500).json({ ok: false, error: 'جدول الإعداد مفقود' });

    const setup = r.rows[0];

    if (setup.is_completed) {
      return res.status(400).json({ ok: false, error: 'تم الإعداد مسبقاً' });
    }

    if (!tokenEquals(setup.setup_token, token)) {
      return res.status(403).json({ ok: false, error: 'الرمز غير صحيح' });
    }

    res.json({ ok: true });
  } catch (e) { next(e); }
});

// ============================================
// تنفيذ الإعداد الأولي
// ============================================
router.post('/init', async (req, res, next) => {
  try {
    const {
      token,
      business_name, owner_name, owner_phone, owner_email, address, currency,
      admin_username, admin_password,
      branch_name, branch_address, branch_phone
    } = req.body;

    if (!token) return res.status(400).json({ ok: false, error: 'الرمز مطلوب' });
    if (!business_name || !owner_name || !owner_phone) {
      return res.status(400).json({ ok: false, error: 'بيانات المتجر مطلوبة' });
    }
    if (!admin_username || !admin_password) {
      return res.status(400).json({ ok: false, error: 'بيانات الدخول مطلوبة' });
    }
    const weak = checkPasswordStrength(admin_password);
    if (weak) return res.status(400).json({ ok: false, error: weak });

    const result = await transaction(async (client) => {
      const setupRes = await client.query(
        'SELECT * FROM system_setup WHERE id = 1 FOR UPDATE'
      );
      const setup = setupRes.rows[0];
      if (!setup) throw new HttpError(500, 'جدول الإعداد مفقود');
      if (setup.is_completed) throw new HttpError(400, 'تم الإعداد مسبقاً');
      if (!tokenEquals(setup.setup_token, token)) throw new HttpError(403, 'الرمز غير صحيح');

      const tenantId = uuidv4();
      const tenantCode = 'CLIENT' + String(Date.now()).slice(-6);

      await client.query(
        `INSERT INTO tenants (
          id, tenant_code, business_name, owner_name, owner_phone,
          owner_email, address, currency, plan,
          max_branches, max_users, max_products,
          license_key, api_key,
          is_trial, subscription_status, subscription_end
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,
                  TRUE, 'active', NOW() + ($15::int * INTERVAL '1 day'))`,
        [
          tenantId, tenantCode, business_name, owner_name, owner_phone,
          owner_email || null, address || null, currency || 'LYD',
          'pro', 5, 10, 2000,
          'LIC-' + uuidv4().slice(0, 12).toUpperCase(),
          'api_' + uuidv4().replace(/-/g, ''),
          parseInt(process.env.DEFAULT_TRIAL_DAYS) || 14
        ]
      );

      const branchId = uuidv4();
      await client.query(
        `INSERT INTO branches (id, tenant_id, branch_code, name, address, phone, is_main)
         VALUES ($1, $2, $3, $4, $5, $6, TRUE)`,
        [branchId, tenantId, 'BR001',
         branch_name || 'الفرع الرئيسي',
         branch_address || address || null,
         branch_phone || owner_phone]
      );

      const hash = await bcrypt.hash(admin_password, bcryptRounds());
      const userRes = await client.query(
        `INSERT INTO users (
          tenant_id, branch_id, username, password_hash, full_name, role
        ) VALUES ($1, $2, $3, $4, $5, $6)
        RETURNING id`,
        [tenantId, branchId, admin_username, hash, owner_name, 'tenant_admin']
      );

      await client.query(
        `INSERT INTO tenant_settings (tenant_id, setting_key, setting_value)
         VALUES 
           ($1, 'print_size', '80'),
           ($1, 'print_header', 'شكراً لزيارتكم'),
           ($1, 'print_footer', $2),
           ($1, 'tax_enabled', 'false')`,
        [tenantId, business_name]
      );

      await client.query(
        `UPDATE system_setup 
         SET is_completed = TRUE, 
             completed_at = NOW(),
             updated_at = NOW()
         WHERE id = 1`
      );

      return {
        tenant_id: tenantId,
        tenant_code: tenantCode,
        branch_id: branchId,
        user_id: userRes.rows[0].id
      };
    });

    const jwtToken = signToken({
      id: result.user_id,
      username: admin_username,
      name: owner_name,
      role: 'tenant_admin',
      tenantId: result.tenant_id,
      branchId: result.branch_id,
      tv: 0
    });

    res.json({
      ok: true,
      message: 'تم الإعداد بنجاح',
      token: jwtToken,
      tenant_code: result.tenant_code,
      user: {
        username: admin_username,
        name: owner_name,
        role: 'tenant_admin'
      }
    });

  } catch (e) {
    if (e instanceof HttpError) return res.status(e.status).json({ ok: false, error: e.message });
    console.error('Setup error:', e.message);
    res.status(500).json({ ok: false, error: 'تعذر إكمال الإعداد' });
  }
});

module.exports = router;
