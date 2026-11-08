/** العروض: GET (للجميع داخل المتجر)، والإدارة للمدراء فقط. */
const express = require('express');
const router = express.Router();
const { query } = require('../db');
const { authenticate, requireRole, checkTenantActive, requireTenant } = require('../middleware/auth');
const { logActivity } = require('../middleware/logger');
const { HttpError, num } = require('../lib/util');
const { getBranchFilter } = require('../middleware/branch-filter');

router.use(authenticate, checkTenantActive, requireTenant);
const ADMINS = ['owner', 'tenant_admin', 'branch_manager'];

router.get('/', async (req, res, next) => {
  try {
    const bf = getBranchFilter(req);
    const p = [req.tenantId]; let w = '';
    if (bf.filter && bf.branchId) { p.push(bf.branchId); w = ' AND (pr.branch_id IS NULL OR pr.branch_id = $2)'; }
    const r = await query(
      `SELECT pr.*, p.name AS product_name, b.name AS branch_name,
              (pr.is_active AND pr.starts_at <= NOW() AND (pr.ends_at IS NULL OR pr.ends_at > NOW())) AS running
         FROM promotions pr LEFT JOIN products p ON p.id = pr.product_id LEFT JOIN branches b ON b.id = pr.branch_id
        WHERE pr.tenant_id = $1${w} ORDER BY running DESC, pr.created_at DESC LIMIT 300`, p);
    res.json({ ok: true, data: r.rows });
  } catch (e) { next(e); }
});

router.post('/', requireRole(...ADMINS), async (req, res, next) => {
  try {
    const b = req.body || {};
    const name = String(b.name || '').trim().slice(0, 200);
    if (!name) throw new HttpError(400, 'اسم العرض مطلوب');
    if (!['percent', 'fixed_price'].includes(b.kind)) throw new HttpError(400, 'نوع العرض: percent أو fixed_price');
    const value = num(b.value, { name: 'القيمة', min: 0.01, max: b.kind === 'percent' ? 100 : 1e9 });
    if (!b.product_id && !b.category) throw new HttpError(400, 'حدّد منتجاً أو تصنيفاً');
    const bf = getBranchFilter(req);
    let branchId = b.branch_id || null;
    if (bf.scope === 'own') branchId = bf.branchId; // مدير الفرع: عروض فرعه فقط
    if (branchId) {
      const ok = await query('SELECT 1 FROM branches WHERE id=$1 AND tenant_id=$2', [branchId, req.tenantId]);
      if (!ok.rows.length) throw new HttpError(400, 'الفرع غير موجود');
    }
    if (b.product_id) {
      const pr = await query('SELECT branch_id FROM products WHERE id=$1 AND tenant_id=$2', [b.product_id, req.tenantId]);
      if (!pr.rows.length) throw new HttpError(400, 'المنتج غير موجود');
      if (bf.scope === 'own' && pr.rows[0].branch_id !== bf.branchId) throw new HttpError(403, 'منتج في فرع آخر');
    }
    const starts = b.starts_at ? new Date(b.starts_at) : new Date();
    const ends = b.ends_at ? new Date(b.ends_at) : null;
    if (isNaN(starts) || (ends && isNaN(ends))) throw new HttpError(400, 'تاريخ غير صالح');
    if (ends && ends <= starts) throw new HttpError(400, 'نهاية العرض يجب أن تكون بعد بدايته');
    const r = await query(
      `INSERT INTO promotions (tenant_id, branch_id, name, kind, value, product_id, category, starts_at, ends_at, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [req.tenantId, branchId, name, b.kind, value, b.product_id || null, b.product_id ? null : String(b.category).slice(0, 100), starts, ends, req.user.id]);
    await logActivity(req, 'promotion_create', 'promotion', r.rows[0].id, { name, kind: b.kind, value });
    res.json({ ok: true, data: r.rows[0] });
  } catch (e) { next(e); }
});

// إيقاف/تفعيل
router.put('/:id', requireRole(...ADMINS), async (req, res, next) => {
  try {
    const bf = getBranchFilter(req);
    const cur = await query('SELECT * FROM promotions WHERE id=$1 AND tenant_id=$2', [req.params.id, req.tenantId]);
    if (!cur.rows.length) throw new HttpError(404, 'العرض غير موجود');
    if (bf.scope === 'own' && cur.rows[0].branch_id !== bf.branchId) throw new HttpError(403, 'عرض ليس لفرعك');
    const r = await query('UPDATE promotions SET is_active=$1 WHERE id=$2 RETURNING *', [req.body.is_active === true, req.params.id]);
    await logActivity(req, 'promotion_toggle', 'promotion', req.params.id, { is_active: r.rows[0].is_active });
    res.json({ ok: true, data: r.rows[0] });
  } catch (e) { next(e); }
});

router.delete('/:id', requireRole(...ADMINS), async (req, res, next) => {
  try {
    const bf = getBranchFilter(req);
    const cur = await query('SELECT branch_id FROM promotions WHERE id=$1 AND tenant_id=$2', [req.params.id, req.tenantId]);
    if (!cur.rows.length) throw new HttpError(404, 'العرض غير موجود');
    if (bf.scope === 'own' && cur.rows[0].branch_id !== bf.branchId) throw new HttpError(403, 'عرض ليس لفرعك');
    await query('DELETE FROM promotions WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

module.exports = router;
