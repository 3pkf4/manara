const express = require('express');
const bcrypt = require('bcryptjs');
const router = express.Router();
const { query } = require('../db');
const { authenticate, requireRole, checkTenantActive, requireTenant, ASSIGNABLE_ROLES } = require('../middleware/auth');
const { logActivity } = require('../middleware/logger');
const { validateRequired } = require('../middleware/errors');
const { HttpError } = require('../lib/util');
const { checkPasswordStrength } = require('../lib/password');
const { bcryptRounds } = require('../lib/config');

router.use(authenticate, checkTenantActive, requireTenant);

const isUuid = (v) => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);

function assertRole(role) {
  if (!ASSIGNABLE_ROLES.includes(role)) {
    throw new HttpError(400, 'دور غير صالح. المتاح: ' + ASSIGNABLE_ROLES.join(', '));
  }
}

async function assertBranch(branchId, tenantId) {
  if (branchId === null || branchId === undefined || branchId === '') return null;
  if (!isUuid(branchId)) throw new HttpError(400, 'معرّف الفرع غير صالح');
  const br = await query('SELECT id FROM branches WHERE id = $1 AND tenant_id = $2', [branchId, tenantId]);
  if (!br.rows.length) throw new HttpError(400, 'الفرع غير موجود');
  return branchId;
}

// ============================================
// جلب كل المستخدمين (مع اسم الفرع)
// ============================================
router.get('/', requireRole('owner', 'tenant_admin', 'branch_manager'), async (req, res, next) => {
  try {
    const { branch_id } = req.query;
    let sql = `
      SELECT u.id, u.username, u.full_name, u.email, u.phone, u.role,
             u.is_active, u.last_login, u.created_at, u.branch_id,
             b.name AS branch_name, b.branch_code
      FROM users u
      LEFT JOIN branches b ON b.id = u.branch_id
      WHERE u.tenant_id = $1`;
    const params = [req.tenantId];
    let i = 2;

    if (req.user.role === 'branch_manager') {
      sql += ` AND u.branch_id = $${i}`;
      params.push(req.branchId);
      i++;
    } else if (branch_id) {
      sql += ` AND u.branch_id = $${i}`;
      params.push(branch_id);
      i++;
    }

    sql += ' ORDER BY u.created_at DESC';
    const r = await query(sql, params);
    res.json({ ok: true, data: r.rows });
  } catch (e) { next(e); }
});

router.get('/:id', requireRole('owner', 'tenant_admin', 'branch_manager'), async (req, res, next) => {
  try {
    if (!isUuid(req.params.id)) return res.status(404).json({ ok: false, error: 'المستخدم غير موجود' });
    const r = await query(
      `SELECT u.id, u.username, u.full_name, u.email, u.phone, u.role,
              u.is_active, u.last_login, u.branch_id,
              b.name AS branch_name
       FROM users u
       LEFT JOIN branches b ON b.id = u.branch_id
       WHERE u.id = $1 AND u.tenant_id = $2`,
      [req.params.id, req.tenantId]
    );
    if (!r.rows.length) return res.status(404).json({ ok: false, error: 'المستخدم غير موجود' });
    res.json({ ok: true, data: r.rows[0] });
  } catch (e) { next(e); }
});

// ============================================
// إضافة مستخدم جديد
// ============================================
router.post('/', requireRole('owner', 'tenant_admin'), async (req, res, next) => {
  try {
    const b = req.body || {};
    validateRequired(b, ['username', 'password', 'full_name', 'role']);
    assertRole(b.role);
    if (typeof b.username !== 'string' || !/^[\w.\-@]{3,50}$/.test(b.username.trim())) {
      throw new HttpError(400, 'اسم المستخدم 3–50 حرفاً (أحرف/أرقام/. _ - @)');
    }
    const weak = checkPasswordStrength(b.password);
    if (weak) throw new HttpError(400, weak);

    // الحد المسموح من المستخدمين (يُطبَّق دائماً)
    const t = await query('SELECT max_users FROM tenants WHERE id = $1', [req.tenantId]);
    const count = await query('SELECT COUNT(*) FROM users WHERE tenant_id = $1 AND is_active = TRUE', [req.tenantId]);
    if (parseInt(count.rows[0].count) >= t.rows[0].max_users) {
      throw new HttpError(400, `وصلت للحد الأقصى من المستخدمين (${t.rows[0].max_users}). تواصل مع الدعم.`);
    }

    const branchId = await assertBranch(b.branch_id, req.tenantId);
    if (['branch_manager', 'cashier', 'warehouse'].includes(b.role) && !branchId) {
      throw new HttpError(400, 'هذا الدور يتطلب تحديد فرع');
    }

    const hash = await bcrypt.hash(b.password, bcryptRounds());
    const r = await query(
      `INSERT INTO users (tenant_id, branch_id, username, password_hash,
                          full_name, email, phone, role, is_active)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,TRUE)
       RETURNING id, username, full_name, role, branch_id, is_active`,
      [req.tenantId, branchId, b.username.trim(), hash,
       String(b.full_name).trim(), b.email || null, b.phone || null, b.role]
    );

    await logActivity(req, 'create_user', 'user', r.rows[0].id, { username: b.username, role: b.role });
    res.json({ ok: true, data: r.rows[0] });
  } catch (e) {
    if (e.code === '23505') return res.status(400).json({ ok: false, error: 'اسم المستخدم مستخدم مسبقاً' });
    next(e);
  }
});

// ============================================
// تعديل مستخدم
// ============================================
router.put('/:id', requireRole('owner', 'tenant_admin'), async (req, res, next) => {
  try {
    if (!isUuid(req.params.id)) return res.status(404).json({ ok: false, error: 'المستخدم غير موجود' });
    const b = req.body || {};
    const fields = [];
    const params = [req.params.id, req.tenantId];
    let p = 3;
    let bumpToken = false;

    const cur = await query('SELECT id, role FROM users WHERE id = $1 AND tenant_id = $2', [req.params.id, req.tenantId]);
    if (!cur.rows.length) return res.status(404).json({ ok: false, error: 'المستخدم غير موجود' });
    if (cur.rows[0].role === 'owner') throw new HttpError(403, 'لا يمكن تعديل حساب المالك');

    if (b.role !== undefined) {
      assertRole(b.role);
      if (req.params.id === req.user.id && b.role !== req.user.role) {
        throw new HttpError(400, 'لا يمكنك تغيير دورك بنفسك');
      }
      if (b.role !== cur.rows[0].role) bumpToken = true;
    }
    if (b.branch_id !== undefined) {
      b.branch_id = await assertBranch(b.branch_id, req.tenantId);
      bumpToken = true;
    }
    if (b.is_active !== undefined) {
      if (typeof b.is_active !== 'boolean') throw new HttpError(400, 'is_active يجب أن تكون true/false');
      if (req.params.id === req.user.id && b.is_active === false) throw new HttpError(400, 'لا يمكنك تعطيل حسابك');
    }

    ['full_name', 'email', 'phone', 'role', 'is_active', 'branch_id'].forEach(f => {
      if (b[f] !== undefined) {
        fields.push(`${f} = $${p}`);
        params.push(b[f]);
        p++;
      }
    });

    if (b.password) {
      const weak = checkPasswordStrength(b.password);
      if (weak) throw new HttpError(400, weak);
      const hash = await bcrypt.hash(b.password, bcryptRounds());
      fields.push(`password_hash = $${p}`);
      params.push(hash);
      p++;
      bumpToken = true;
    }

    if (!fields.length) return res.status(400).json({ ok: false, error: 'لا توجد بيانات للتعديل' });
    if (bumpToken || b.is_active === false) fields.push('token_version = token_version + 1');
    fields.push('updated_at = NOW()');

    const r = await query(
      `UPDATE users SET ${fields.join(', ')}
       WHERE id = $1 AND tenant_id = $2
       RETURNING id, username, full_name, role, branch_id, is_active`,
      params
    );
    if (!r.rows.length) return res.status(404).json({ ok: false, error: 'المستخدم غير موجود' });

    await logActivity(req, 'update_user', 'user', req.params.id);
    res.json({ ok: true, data: r.rows[0] });
  } catch (e) { next(e); }
});

// ============================================
// تعطيل/تفعيل مستخدم
// ============================================
router.post('/:id/toggle', requireRole('owner', 'tenant_admin'), async (req, res, next) => {
  try {
    if (!isUuid(req.params.id)) return res.status(404).json({ ok: false, error: 'المستخدم غير موجود' });
    if (req.params.id === req.user.id) {
      return res.status(400).json({ ok: false, error: 'لا يمكنك تعطيل حسابك' });
    }
    const r = await query(
      `UPDATE users SET is_active = NOT is_active, token_version = token_version + 1, updated_at = NOW()
       WHERE id = $1 AND tenant_id = $2 AND role <> 'owner'
       RETURNING id, is_active`,
      [req.params.id, req.tenantId]
    );
    if (!r.rows.length) return res.status(404).json({ ok: false, error: 'المستخدم غير موجود' });

    await logActivity(req, r.rows[0].is_active ? 'activate_user' : 'deactivate_user', 'user', req.params.id);
    res.json({ ok: true, data: r.rows[0] });
  } catch (e) { next(e); }
});

// ============================================
// حذف مستخدم (تعطيل إن كانت له فواتير)
// ============================================
router.delete('/:id', requireRole('owner', 'tenant_admin'), async (req, res, next) => {
  try {
    if (!isUuid(req.params.id)) return res.status(404).json({ ok: false, error: 'المستخدم غير موجود' });
    if (req.params.id === req.user.id) {
      return res.status(400).json({ ok: false, error: 'لا يمكنك حذف حسابك' });
    }
    const own = await query("SELECT id FROM users WHERE id = $1 AND tenant_id = $2 AND role <> 'owner'",
      [req.params.id, req.tenantId]);
    if (!own.rows.length) return res.status(404).json({ ok: false, error: 'المستخدم غير موجود' });

    const check = await query(
      'SELECT COUNT(*) FROM invoices WHERE user_id = $1 AND tenant_id = $2', [req.params.id, req.tenantId]);
    if (parseInt(check.rows[0].count) > 0) {
      await query('UPDATE users SET is_active = FALSE, token_version = token_version + 1 WHERE id = $1 AND tenant_id = $2',
        [req.params.id, req.tenantId]);
      await logActivity(req, 'deactivate_user', 'user', req.params.id);
      return res.json({ ok: true, message: 'تم تعطيل المستخدم (له فواتير مسجلة)' });
    }
    await query('DELETE FROM users WHERE id = $1 AND tenant_id = $2', [req.params.id, req.tenantId]);
    await logActivity(req, 'delete_user', 'user', req.params.id);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

module.exports = router;
