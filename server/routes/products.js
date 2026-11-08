const express = require('express');
const router = express.Router();
const { query, transaction } = require('../db');
const { authenticate, requireRole, checkTenantActive } = require('../middleware/auth');
const { logActivity } = require('../middleware/logger');
const { HttpError, num, round2 } = require('../lib/util');
const { validateRequired } = require('../middleware/errors');
const { getBranchFilter, resolveBranchForInsert } = require('../middleware/branch-filter');
const { normPlu, barcodeConflict, lookupByCode } = require('../lib/barcode');
const { PROMO_LATERAL } = require('../lib/promo');

function cleanBarcode(v) {
  if (v === undefined || v === null || String(v).trim() === '') return null;
  const c = String(v).trim();
  if (c.length > 100 || /[\s\u0000-\u001f]/.test(c)) throw new HttpError(400, 'الباركود غير صالح (بدون مسافات، حتى 100 حرف)');
  return c;
}

router.use(authenticate, checkTenantActive);

// ============================================
// جلب المنتجات
// ============================================
router.get('/', async (req, res, next) => {
  try {
    const { search, category, low_stock, active } = req.query;
    const bf = getBranchFilter(req);

    let sql = `SELECT p.*, b.name AS branch_name, b.branch_code, promo.price AS promo_price, promo.name AS promo_name,
                      (SELECT COALESCE(json_agg(json_build_object('id', pb.id, 'barcode', pb.barcode, 'pack_qty', pb.pack_qty, 'label', pb.label)), '[]'::json)
                         FROM product_barcodes pb WHERE pb.product_id = p.id) AS extra_barcodes
               FROM products p
               LEFT JOIN branches b ON b.id = p.branch_id
               ${PROMO_LATERAL}
               WHERE p.tenant_id = $1`;
    const params = [req.tenantId];
    let i = 2;

    if (bf.filter && bf.branchId) {
      sql += ` AND p.branch_id = $${i}`;
      params.push(bf.branchId);
      i++;
    }

    if (search) {
      sql += ` AND (p.name ILIKE $${i} OR p.barcode ILIKE $${i} OR EXISTS (SELECT 1 FROM product_barcodes pb WHERE pb.product_id = p.id AND pb.barcode ILIKE $${i}))`;
      params.push(`%${search}%`);
      i++;
    }
    if (category) { sql += ` AND p.category = $${i}`; params.push(category); i++; }
    if (low_stock === 'true') { sql += ` AND p.is_service = FALSE AND p.stock <= p.min_stock`; }
    if (active === 'false') { sql += ` AND p.is_active = FALSE`; }
    else if (active !== 'all') { sql += ` AND p.is_active = TRUE`; }

    sql += ' ORDER BY p.name ASC LIMIT 2000';
    const r = await query(sql, params);
    res.json({ ok: true, data: r.rows });
  } catch (e) { next(e); }
});

// جلب منتج واحد
router.get('/:id', async (req, res, next) => {
  try {
    const r = await query(
      'SELECT * FROM products WHERE id = $1 AND tenant_id = $2',
      [req.params.id, req.tenantId]
    );
    if (!r.rows.length) return res.status(404).json({ ok: false, error: 'المنتج غير موجود' });

    const bf = getBranchFilter(req);
    if (bf.scope === 'own' && r.rows[0].branch_id !== bf.branchId) {
      return res.status(403).json({ ok: false, error: 'هذا المنتج ليس في فرعك' });
    }
    res.json({ ok: true, data: r.rows[0] });
  } catch (e) { next(e); }
});

// البحث بالباركود (رئيسي، إضافي، أو باركود ميزان). يعيد المنتج + scan {qty, kind}
router.get('/barcode/:code', async (req, res, next) => {
  try {
    const bf = getBranchFilter(req);
    const hit = await lookupByCode({ query }, req.tenantId, bf.filter && bf.branchId ? bf.branchId : null, req.params.code);
    if (!hit) return res.status(404).json({ ok: false, error: 'المنتج غير موجود' });
    res.json({ ok: true, data: hit.product, scan: { qty: hit.qty, kind: hit.kind } });
  } catch (e) { next(e); }
});

// إضافة منتج
router.post('/', requireRole('owner', 'tenant_admin', 'branch_manager', 'warehouse'), async (req, res, next) => {
  try {
    const b = req.body;
    validateRequired(b, ['name', 'sell_price']);

    const branchId = await resolveBranchForInsert(req, query);
    if (!branchId) return res.status(400).json({ ok: false, error: 'يجب تحديد الفرع' });

    const sellPrice = num(b.sell_price, { name: 'سعر البيع', min: 0, max: 1e9 });
    const costPrice = num(b.cost_price, { name: 'سعر التكلفة', min: 0, max: 1e9, def: 0 });
    const wholesale = num(b.wholesale_price, { name: 'سعر الجملة', min: 0, max: 1e9, def: 0 });
    const stockQty = num(b.stock, { name: 'الكمية', min: 0, max: 1e9, def: 0 });
    const minStock = num(b.min_stock, { name: 'الحد الأدنى', min: 0, max: 1e9, def: 5 });
    const taxRate = num(b.tax_rate, { name: 'الضريبة', min: 0, max: 100, def: 0 });
    if (b.expiry_date && !/^\d{4}-\d{2}-\d{2}$/.test(b.expiry_date)) throw new HttpError(400, 'صيغة تاريخ الصلاحية YYYY-MM-DD');

    const barcode = cleanBarcode(b.barcode);
    if (barcode) {
      const dup = await barcodeConflict({ query }, req.tenantId, branchId, barcode, null);
      if (dup) throw new HttpError(409, `هذا الباركود مستخدم للمنتج «${dup}»`);
    }
    const sbw = b.sold_by_weight === true;
    const plu = b.plu ? normPlu(b.plu) : null;
    if (b.plu && !/^\d{1,6}$/.test(String(b.plu))) throw new HttpError(400, 'رمز الميزان (PLU) أرقام فقط حتى 6 خانات');
    if (sbw && !plu) throw new HttpError(400, 'المنتج بالوزن يحتاج رمز ميزان (PLU)');

    const lim = await query(
      `SELECT t.max_products, (SELECT COUNT(*) FROM products WHERE tenant_id = t.id AND is_active) AS n
         FROM tenants t WHERE t.id = $1`, [req.tenantId]);
    if (lim.rows.length && parseInt(lim.rows[0].n) >= lim.rows[0].max_products) {
      throw new HttpError(400, `وصلت للحد الأقصى من المنتجات (${lim.rows[0].max_products}). تواصل مع الدعم للترقية.`);
    }

    const r = await query(
      `INSERT INTO products (
        tenant_id, branch_id, name, barcode, sku, category, description,
        sell_price, cost_price, wholesale_price,
        stock, min_stock, unit, is_service, tax_rate, created_by, expiry_date, plu, sold_by_weight
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
      RETURNING *`,
      [
        req.tenantId, branchId, b.name, barcode, b.sku || null,
        b.category || 'عام', b.description || null,
        sellPrice, costPrice, wholesale,
        stockQty, minStock,
        b.unit || 'قطعة', b.is_service === true, taxRate,
        req.user.id, b.expiry_date || null, plu, sbw
      ]
    );

    await logActivity(req, 'create_product', 'product', r.rows[0].id, {
      name: b.name, branch_id: branchId
    });
    res.json({ ok: true, data: r.rows[0] });
  } catch (e) { next(e); }
});

// تعديل منتج
router.put('/:id', requireRole('owner', 'tenant_admin', 'branch_manager', 'warehouse'), async (req, res, next) => {
  try {
    const p = await query(
      'SELECT branch_id FROM products WHERE id = $1 AND tenant_id = $2',
      [req.params.id, req.tenantId]
    );
    if (!p.rows.length) return res.status(404).json({ ok: false, error: 'المنتج غير موجود' });

    const bf = getBranchFilter(req);
    if (bf.scope === 'own' && p.rows[0].branch_id !== bf.branchId) {
      return res.status(403).json({ ok: false, error: 'لا يمكنك تعديل منتجات فرع آخر' });
    }

    const b = req.body;
    if (b.barcode !== undefined) {
      b.barcode = cleanBarcode(b.barcode);
      if (b.barcode) {
        const dup = await barcodeConflict({ query }, req.tenantId, p.rows[0].branch_id, b.barcode, req.params.id);
        if (dup) throw new HttpError(409, `هذا الباركود مستخدم للمنتج «${dup}»`);
      }
    }
    if (b.plu !== undefined) {
      if (b.plu === '' || b.plu === null) b.plu = null;
      else if (!/^\d{1,6}$/.test(String(b.plu))) throw new HttpError(400, 'رمز الميزان (PLU) أرقام فقط حتى 6 خانات');
      else b.plu = normPlu(b.plu);
    }
    const fields = [];
    const params = [req.params.id, req.tenantId];
    let i = 3;

    const allowed = ['name', 'barcode', 'sku', 'category', 'description',
                     'sell_price', 'cost_price', 'wholesale_price',
                     'min_stock', 'unit', 'is_service', 'is_active', 'tax_rate', 'expiry_date', 'plu', 'sold_by_weight'];
    for (const f of ['sell_price', 'cost_price', 'wholesale_price', 'min_stock', 'tax_rate']) {
      if (b[f] !== undefined) b[f] = num(b[f], { name: f, min: 0, max: 1e9 });
    }
    if (b.expiry_date === '') b.expiry_date = null;
    if (b.expiry_date && !/^\d{4}-\d{2}-\d{2}$/.test(b.expiry_date)) throw new HttpError(400, 'صيغة تاريخ الصلاحية YYYY-MM-DD');

    allowed.forEach(f => {
      if (b[f] !== undefined) { fields.push(`${f} = $${i}`); params.push(b[f]); i++; }
    });

    if (!fields.length) return res.status(400).json({ ok: false, error: 'لا توجد بيانات' });

    const r = await query(
      `UPDATE products SET ${fields.join(', ')} WHERE id = $1 AND tenant_id = $2 RETURNING *`,
      params
    );

    await logActivity(req, 'update_product', 'product', req.params.id);
    res.json({ ok: true, data: r.rows[0] });
  } catch (e) { next(e); }
});

// تعديل المخزون
router.post('/:id/adjust-stock', requireRole('owner', 'tenant_admin', 'branch_manager', 'warehouse'), async (req, res, next) => {
  try {
    const { new_stock, reason } = req.body || {};
    if (new_stock === undefined) return res.status(400).json({ ok: false, error: 'الكمية مطلوبة' });
    const after = num(new_stock, { name: 'الكمية', min: 0, max: 1e9 });

    const out = await transaction(async (client) => {
      const p = await client.query(
        'SELECT branch_id, stock FROM products WHERE id = $1 AND tenant_id = $2 FOR UPDATE',
        [req.params.id, req.tenantId]);
      if (!p.rows.length) throw new HttpError(404, 'المنتج غير موجود');
      const bf = getBranchFilter(req);
      if (bf.scope === 'own' && p.rows[0].branch_id !== bf.branchId) throw new HttpError(403, 'لا يمكنك تعديل مخزون فرع آخر');
      const before = parseFloat(p.rows[0].stock);
      await client.query('UPDATE products SET stock = $1, updated_at = NOW() WHERE id = $2', [after, req.params.id]);
      await client.query(
        `INSERT INTO stock_movements (tenant_id, branch_id, product_id, user_id, movement_type, quantity, stock_before, stock_after, notes)
         VALUES ($1,$2,$3,$4,'adjustment',$5,$6,$7,$8)`,
        [req.tenantId, p.rows[0].branch_id, req.params.id, req.user.id, after - before, before, after,
         reason ? String(reason).slice(0, 300) : 'تعديل يدوي']);
      return after;
    });
    res.json({ ok: true, data: { stock: out } });
  } catch (e) { next(e); }
});

// حذف منتج
router.delete('/:id', requireRole('owner', 'tenant_admin'), async (req, res, next) => {
  try {
    const p = await query(
      'SELECT branch_id FROM products WHERE id = $1 AND tenant_id = $2',
      [req.params.id, req.tenantId]
    );
    if (!p.rows.length) return res.status(404).json({ ok: false, error: 'المنتج غير موجود' });

    const check = await query(
      'SELECT COUNT(*) FROM invoice_items WHERE product_id = $1',
      [req.params.id]
    );

    if (parseInt(check.rows[0].count) > 0) {
      await query('UPDATE products SET is_active = FALSE WHERE id = $1', [req.params.id]);
      return res.json({ ok: true, message: 'تم إلغاء تنشيط المنتج' });
    }

    await query('DELETE FROM products WHERE id = $1 AND tenant_id = $2',
      [req.params.id, req.tenantId]);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

module.exports = router;
