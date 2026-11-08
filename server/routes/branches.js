const express = require('express');
const router = express.Router();
const { query, transaction } = require('../db');
const { authenticate, requireRole, checkTenantActive } = require('../middleware/auth');
const { logActivity } = require('../middleware/logger');
const { validateRequired } = require('../middleware/errors');

router.use(authenticate, checkTenantActive);

// ============================================
// جلب كل الفروع
// ============================================
router.get('/', async (req, res, next) => {
  try {
    const r = await query(
      `SELECT b.*,
         (SELECT COUNT(*) FROM users WHERE branch_id = b.id AND is_active = TRUE) AS user_count,
         (SELECT COUNT(*) FROM invoices WHERE branch_id = b.id AND status = 'completed') AS invoice_count,
         (SELECT COALESCE(SUM(total), 0) FROM invoices WHERE branch_id = b.id AND status = 'completed') AS total_sales,
         (SELECT COALESCE(SUM(profit), 0) FROM invoices WHERE branch_id = b.id AND status = 'completed') AS total_profit
       FROM branches b
       WHERE b.tenant_id = $1
       ORDER BY b.is_main DESC, b.created_at ASC`,
      [req.tenantId]
    );
    res.json({ ok: true, data: r.rows });
  } catch (e) { next(e); }
});

// ============================================
// جلب فرع واحد
// ============================================
router.get('/:id', async (req, res, next) => {
  try {
    const r = await query(
      'SELECT * FROM branches WHERE id = $1 AND tenant_id = $2',
      [req.params.id, req.tenantId]
    );
    if (!r.rows.length) return res.status(404).json({ ok: false, error: 'الفرع غير موجود' });
    res.json({ ok: true, data: r.rows[0] });
  } catch (e) { next(e); }
});

// ============================================
// إضافة فرع جديد
// ============================================
router.post('/', requireRole('owner', 'tenant_admin'), async (req, res, next) => {
  try {
    const b = req.body;
    validateRequired(b, ['name', 'branch_code']);

    // التحقق من الحد المسموح
    const t = await query('SELECT max_branches FROM tenants WHERE id = $1', [req.tenantId]);
    const count = await query('SELECT COUNT(*) FROM branches WHERE tenant_id = $1', [req.tenantId]);
    
    if (parseInt(count.rows[0].count) >= t.rows[0].max_branches) {
      return res.status(400).json({
        ok: false,
        error: `وصلت للحد الأقصى من الفروع (${t.rows[0].max_branches}). تواصل مع الدعم لزيادتها.`
      });
    }

    const r = await query(
      `INSERT INTO branches (tenant_id, branch_code, name, address, phone, is_main)
       VALUES ($1, $2, $3, $4, $5, FALSE) RETURNING *`,
      [req.tenantId, b.branch_code.trim(), b.name.trim(),
       b.address || null, b.phone || null]
    );

    await logActivity(req, 'create_branch', 'branch', r.rows[0].id, { name: b.name });
    res.json({ ok: true, data: r.rows[0] });
  } catch (e) {
    if (e.code === '23505') return res.status(400).json({ ok: false, error: 'كود الفرع مستخدم مسبقاً' });
    next(e);
  }
});

// ============================================
// تعديل فرع
// ============================================
router.put('/:id', requireRole('owner', 'tenant_admin'), async (req, res, next) => {
  try {
    const b = req.body;
    const fields = [];
    const params = [req.params.id, req.tenantId];
    let p = 3;

    ['name', 'address', 'phone', 'is_active'].forEach(f => {
      if (b[f] !== undefined) { fields.push(`${f} = $${p}`); params.push(b[f]); p++; }
    });

    if (!fields.length) return res.status(400).json({ ok: false, error: 'لا توجد بيانات' });

    const r = await query(
      `UPDATE branches SET ${fields.join(', ')} WHERE id = $1 AND tenant_id = $2 RETURNING *`,
      params
    );
    if (!r.rows.length) return res.status(404).json({ ok: false, error: 'الفرع غير موجود' });

    await logActivity(req, 'update_branch', 'branch', req.params.id);
    res.json({ ok: true, data: r.rows[0] });
  } catch (e) { next(e); }
});

// ============================================
// حذف فرع
// ============================================
router.delete('/:id', requireRole('owner', 'tenant_admin'), async (req, res, next) => {
  try {
    const b = await query(
      'SELECT is_main FROM branches WHERE id = $1 AND tenant_id = $2',
      [req.params.id, req.tenantId]
    );
    if (!b.rows.length) return res.status(404).json({ ok: false, error: 'الفرع غير موجود' });
    if (b.rows[0].is_main) return res.status(400).json({ ok: false, error: 'لا يمكن حذف الفرع الرئيسي' });

    // إذا كان يحتوي بيانات، نعطله فقط
    const check = await query(
      `SELECT 
        (SELECT COUNT(*) FROM users WHERE branch_id = $1) AS users,
        (SELECT COUNT(*) FROM invoices WHERE branch_id = $1) AS invoices`,
      [req.params.id]
    );

    if (parseInt(check.rows[0].users) > 0 || parseInt(check.rows[0].invoices) > 0) {
      await query('UPDATE branches SET is_active = FALSE WHERE id = $1', [req.params.id]);
      return res.json({ ok: true, message: 'تم إلغاء تنشيط الفرع (يحتوي على بيانات)' });
    }

    await query('DELETE FROM branches WHERE id = $1 AND tenant_id = $2',
      [req.params.id, req.tenantId]);
    await logActivity(req, 'delete_branch', 'branch', req.params.id);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// ============================================
// نقل مستخدم إلى فرع
// ============================================
router.post('/:id/assign-user', requireRole('owner', 'tenant_admin'), async (req, res, next) => {
  try {
    const { user_id } = req.body;
    if (!user_id) return res.status(400).json({ ok: false, error: 'يجب تحديد المستخدم' });

    // تحقق أن الفرع لهذا المستأجر
    const b = await query(
      'SELECT id FROM branches WHERE id = $1 AND tenant_id = $2',
      [req.params.id, req.tenantId]
    );
    if (!b.rows.length) return res.status(404).json({ ok: false, error: 'الفرع غير موجود' });

    // تحقق أن المستخدم لهذا المستأجر
    const u = await query(
      'SELECT id FROM users WHERE id = $1 AND tenant_id = $2',
      [user_id, req.tenantId]
    );
    if (!u.rows.length) return res.status(404).json({ ok: false, error: 'المستخدم غير موجود' });

    await query(
      'UPDATE users SET branch_id = $1 WHERE id = $2',
      [req.params.id, user_id]
    );

    await logActivity(req, 'assign_user_branch', 'user', user_id, { branch_id: req.params.id });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

module.exports = router;
