/**
 * ضبط المخزون: تسويات بأسباب، سجل الحركة، جرد، تحويلات بين الفروع،
 * باركودات إضافية وتوليد باركود داخلي، واقتراح إعادة الطلب.
 */
const express = require('express');
const router = express.Router();
const { query, transaction } = require('../db');
const { authenticate, requireRole, checkTenantActive, requireTenant } = require('../middleware/auth');
const { logActivity } = require('../middleware/logger');
const { HttpError, num, nextNumber } = require('../lib/util');
const { getBranchFilter, resolveBranchForInsert } = require('../middleware/branch-filter');
const { internalEAN13, barcodeConflict, lookupByCode } = require('../lib/barcode');

router.use(authenticate, checkTenantActive, requireTenant);
const INV = ['owner', 'tenant_admin', 'branch_manager', 'warehouse'];
const REASONS = { damage: 'تالف', expired: 'منتهي الصلاحية', theft: 'فقد/سرقة', found: 'زيادة وُجدت', correction: 'تصحيح خطأ',
  internal_use: 'استهلاك داخلي', gift: 'عينة/هدية', other: 'أخرى' };

/** يتأكد أن الفرع يتبع المتجر ويُسمح للمستخدم به. */
async function allowedBranch(db, req, wanted) {
  const bf = getBranchFilter(req);
  let id = wanted;
  if (bf.scope === 'own') id = bf.branchId;
  if (!id) id = await resolveBranchForInsert(req, db.query.bind(db));
  const r = await db.query('SELECT id FROM branches WHERE id=$1 AND tenant_id=$2', [id, req.tenantId]);
  if (!r.rows.length) throw new HttpError(400, 'الفرع غير موجود');
  return id;
}
async function loadProduct(client, req, id) {
  const r = await client.query('SELECT * FROM products WHERE id=$1 AND tenant_id=$2 FOR UPDATE', [id, req.tenantId]);
  if (!r.rows.length) throw new HttpError(404, 'المنتج غير موجود');
  const bf = getBranchFilter(req);
  if (bf.scope === 'own' && r.rows[0].branch_id !== bf.branchId) throw new HttpError(403, 'هذا المنتج في فرع آخر');
  return r.rows[0];
}
const mov = (client, req, p, type, qty, before, after, refId, refType, notes) => client.query(
  `INSERT INTO stock_movements (tenant_id, branch_id, product_id, user_id, movement_type, quantity, stock_before, stock_after, reference_id, reference_type, notes)
   VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
  [req.tenantId, p.branch_id, p.id, req.user.id, type, qty, before, after, refId || null, refType || null, notes ? String(notes).slice(0, 300) : null]);

// ---------- سجل الحركة ----------
router.get('/movements', async (req, res, next) => {
  try {
    const bf = getBranchFilter(req);
    const p = [req.tenantId]; let w = '';
    if (bf.filter && bf.branchId) { p.push(bf.branchId); w += ` AND m.branch_id = $${p.length}`; }
    if (req.query.product_id) { p.push(req.query.product_id); w += ` AND m.product_id = $${p.length}`; }
    if (req.query.type) { p.push(String(req.query.type)); w += ` AND m.movement_type = $${p.length}`; }
    if (req.query.from) { p.push(req.query.from); w += ` AND m.created_at >= $${p.length}::date`; }
    if (req.query.to) { p.push(req.query.to); w += ` AND m.created_at < ($${p.length}::date + 1)`; }
    const limit = Math.min(parseInt(req.query.limit) || 100, 500);
    const r = await query(
      `SELECT m.id, m.movement_type, m.quantity, m.stock_before, m.stock_after, m.notes, m.created_at,
              p.name AS product_name, p.barcode, u.full_name AS user_name
         FROM stock_movements m JOIN products p ON p.id = m.product_id LEFT JOIN users u ON u.id = m.user_id
        WHERE m.tenant_id = $1${w} ORDER BY m.created_at DESC LIMIT ${limit}`, p);
    res.json({ ok: true, data: r.rows, reasons: REASONS });
  } catch (e) { next(e); }
});

// ---------- تسوية مخزون بسبب ----------
router.post('/adjust', requireRole(...INV), async (req, res, next) => {
  try {
    const { product_id, delta, new_stock, reason_code, notes } = req.body || {};
    if (!REASONS[reason_code]) throw new HttpError(400, 'سبب التسوية مطلوب: ' + Object.keys(REASONS).join(' | '));
    if ((delta === undefined) === (new_stock === undefined)) throw new HttpError(400, 'أرسل delta أو new_stock (واحداً فقط)');
    const out = await transaction(async (client) => {
      const p = await loadProduct(client, req, product_id);
      if (p.is_service) throw new HttpError(400, 'الخدمات ليس لها مخزون');
      const before = parseFloat(p.stock);
      const after = delta !== undefined ? before + num(delta, { name: 'الفرق', min: -1e9, max: 1e9 }) : num(new_stock, { name: 'الكمية', min: 0, max: 1e9 });
      if (after < 0) throw new HttpError(400, `لا يمكن أن يصبح المخزون سالباً (المتوفر ${before})`);
      await client.query('UPDATE products SET stock=$1, updated_at=NOW() WHERE id=$2', [after, p.id]);
      await mov(client, req, p, reason_code, after - before, before, after, null, 'adjust', `[${REASONS[reason_code]}] ${notes || ''}`.trim());
      return { stock_before: before, stock_after: after };
    });
    await logActivity(req, 'stock_adjust', 'product', product_id, { reason_code, ...out });
    res.json({ ok: true, data: out });
  } catch (e) { next(e); }
});

// ---------- باركودات إضافية ----------
router.post('/products/:id/barcodes', requireRole(...INV), async (req, res, next) => {
  try {
    const code = String(req.body.barcode || '').trim();
    if (!code || code.length > 100 || /[\s\u0000-\u001f]/.test(code)) throw new HttpError(400, 'باركود غير صالح');
    const pack = num(req.body.pack_qty, { name: 'عدد الحبات', min: 0.001, max: 100000, def: 1 });
    const out = await transaction(async (client) => {
      const p = await loadProduct(client, req, req.params.id);
      const dup = await barcodeConflict(client, req.tenantId, p.branch_id, code, p.id);
      if (dup) throw new HttpError(409, `هذا الباركود مستخدم للمنتج «${dup}»`);
      if (p.barcode === code) throw new HttpError(409, 'هذا هو الباركود الرئيسي للمنتج نفسه');
      const r = await client.query(
        `INSERT INTO product_barcodes (tenant_id, branch_id, product_id, barcode, pack_qty, label) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
        [req.tenantId, p.branch_id, p.id, code, pack, req.body.label ? String(req.body.label).slice(0, 100) : null]);
      return r.rows[0];
    });
    res.json({ ok: true, data: out });
  } catch (e) { next(e); }
});
router.delete('/products/:id/barcodes/:bid', requireRole(...INV), async (req, res, next) => {
  try {
    await transaction(async (client) => {
      await loadProduct(client, req, req.params.id);
      await client.query('DELETE FROM product_barcodes WHERE id=$1 AND product_id=$2 AND tenant_id=$3', [req.params.bid, req.params.id, req.tenantId]);
    });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// ---------- توليد باركود داخلي للمنتجات بلا باركود ----------
router.post('/barcodes/generate', requireRole(...INV), async (req, res, next) => {
  try {
    const ids = Array.isArray(req.body.product_ids) ? req.body.product_ids.slice(0, 2000) : null;
    const out = await transaction(async (client) => {
      const bf = getBranchFilter(req);
      const p = [req.tenantId]; let w = '';
      if (bf.filter && bf.branchId) { p.push(bf.branchId); w += ` AND branch_id = $${p.length}`; }
      if (ids) { p.push(ids); w += ` AND id = ANY($${p.length}::uuid[])`; }
      const rows = (await client.query(
        `SELECT id FROM products WHERE tenant_id=$1 AND is_active AND NOT sold_by_weight AND (barcode IS NULL OR barcode = '')${w} ORDER BY name LIMIT 2000 FOR UPDATE`, p)).rows;
      const made = [];
      for (const r of rows) {
        const c = await client.query(
          `INSERT INTO doc_counters (tenant_id, doc_type, year, last_value) VALUES ($1,'BARCODE',0,1)
           ON CONFLICT (tenant_id, doc_type, year) DO UPDATE SET last_value = doc_counters.last_value + 1 RETURNING last_value`, [req.tenantId]);
        const code = internalEAN13(c.rows[0].last_value);
        await client.query('UPDATE products SET barcode=$1, updated_at=NOW() WHERE id=$2', [code, r.id]);
        made.push({ id: r.id, barcode: code });
      }
      return made;
    });
    await logActivity(req, 'generate_barcodes', 'product', null, { count: out.length });
    res.json({ ok: true, data: { count: out.length, items: out.slice(0, 50) } });
  } catch (e) { next(e); }
});

// ---------- الجرد ----------
router.post('/stocktakes', requireRole(...INV), async (req, res, next) => {
  try {
    const out = await transaction(async (client) => {
      const branchId = await allowedBranch({ query: client.query.bind(client) }, req, req.body.branch_id);
      const number = await nextNumber(client, req.tenantId, 'STK', 'STK');
      const r = await client.query(
        `INSERT INTO stocktakes (tenant_id, branch_id, number, name, notes, created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
        [req.tenantId, branchId, number, req.body.name ? String(req.body.name).slice(0, 200) : null, req.body.notes || null, req.user.id]);
      return r.rows[0];
    });
    res.json({ ok: true, data: out });
  } catch (e) { next(e); }
});

router.get('/stocktakes', requireRole(...INV, 'accountant'), async (req, res, next) => {
  try {
    const bf = getBranchFilter(req);
    const p = [req.tenantId]; let w = '';
    if (bf.filter && bf.branchId) { p.push(bf.branchId); w = ` AND s.branch_id = $2`; }
    const r = await query(
      `SELECT s.*, (SELECT COUNT(*) FROM stocktake_items i WHERE i.stocktake_id = s.id)::int AS items_count
         FROM stocktakes s WHERE s.tenant_id = $1${w} ORDER BY s.created_at DESC LIMIT 100`, p);
    res.json({ ok: true, data: r.rows });
  } catch (e) { next(e); }
});

router.get('/stocktakes/:id', requireRole(...INV, 'accountant'), async (req, res, next) => {
  try {
    const bf = getBranchFilter(req);
    const s = await query('SELECT * FROM stocktakes WHERE id=$1 AND tenant_id=$2', [req.params.id, req.tenantId]);
    if (!s.rows.length) throw new HttpError(404, 'الجرد غير موجود');
    if (bf.scope === 'own' && s.rows[0].branch_id !== bf.branchId) throw new HttpError(403, 'جرد فرع آخر');
    const items = await query(
      `SELECT i.product_id, p.name, p.barcode, p.unit, p.cost_price, i.expected, i.counted, (i.counted - i.expected) AS variance,
              ((i.counted - i.expected) * p.cost_price) AS variance_value
         FROM stocktake_items i JOIN products p ON p.id = i.product_id WHERE i.stocktake_id = $1 ORDER BY ABS(i.counted - i.expected) DESC, p.name`, [req.params.id]);
    const sum = items.rows.reduce((a, r) => {
      const v = parseFloat(r.variance_value);
      if (v < 0) a.shortage_value += -v; else a.surplus_value += v;
      return a;
    }, { shortage_value: 0, surplus_value: 0 });
    res.json({ ok: true, data: { ...s.rows[0], items: items.rows, summary: sum } });
  } catch (e) { next(e); }
});

// تسجيل عدّ صنف: بالباركود (مسح متكرر يزيد 1) أو بمعرّف المنتج والكمية الفعلية
router.post('/stocktakes/:id/count', requireRole(...INV), async (req, res, next) => {
  try {
    const out = await transaction(async (client) => {
      const s = (await client.query('SELECT * FROM stocktakes WHERE id=$1 AND tenant_id=$2 FOR UPDATE', [req.params.id, req.tenantId])).rows[0];
      if (!s) throw new HttpError(404, 'الجرد غير موجود');
      const bf = getBranchFilter(req);
      if (bf.scope === 'own' && s.branch_id !== bf.branchId) throw new HttpError(403, 'جرد فرع آخر');
      if (s.status !== 'open') throw new HttpError(400, 'هذا الجرد مغلق');

      let product, add = null, setTo = null;
      if (req.body.code) {
        const hit = await lookupByCode(client, req.tenantId, s.branch_id, req.body.code);
        if (!hit) throw new HttpError(404, 'باركود غير معروف');
        product = hit.product; add = hit.qty;
      } else {
        const pr = await client.query('SELECT * FROM products WHERE id=$1 AND tenant_id=$2 AND branch_id=$3', [req.body.product_id, req.tenantId, s.branch_id]);
        if (!pr.rows.length) throw new HttpError(404, 'المنتج غير موجود في هذا الفرع');
        product = pr.rows[0];
        if (req.body.mode === 'add') add = num(req.body.counted, { name: 'الكمية', min: 0.001, max: 1e9 });
        else setTo = num(req.body.counted, { name: 'الكمية', min: 0, max: 1e9 });
      }
      if (product.is_service) throw new HttpError(400, 'الخدمات لا تُجرد');
      const cur = (await client.query('SELECT stock FROM products WHERE id=$1', [product.id])).rows[0].stock;
      const prev = (await client.query('SELECT counted FROM stocktake_items WHERE stocktake_id=$1 AND product_id=$2', [s.id, product.id])).rows[0];
      const counted = setTo !== null ? setTo : (prev ? parseFloat(prev.counted) : 0) + add;
      const r = await client.query(
        `INSERT INTO stocktake_items (stocktake_id, tenant_id, product_id, expected, counted, counted_by)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (stocktake_id, product_id) DO UPDATE SET expected = EXCLUDED.expected, counted = EXCLUDED.counted, counted_by = EXCLUDED.counted_by, updated_at = NOW()
         RETURNING expected, counted`, [s.id, req.tenantId, product.id, cur, counted, req.user.id]);
      return { product_id: product.id, name: product.name, unit: product.unit, expected: r.rows[0].expected, counted: r.rows[0].counted };
    });
    res.json({ ok: true, data: out });
  } catch (e) { next(e); }
});

// إغلاق الجرد وتطبيق الفروقات (فرق = المعدود − المتوقع لحظة العد، يُضاف للمخزون الحالي)
router.post('/stocktakes/:id/close', requireRole('owner', 'tenant_admin', 'branch_manager'), async (req, res, next) => {
  try {
    const apply = req.body.apply !== false;
    const out = await transaction(async (client) => {
      const s = (await client.query('SELECT * FROM stocktakes WHERE id=$1 AND tenant_id=$2 FOR UPDATE', [req.params.id, req.tenantId])).rows[0];
      if (!s) throw new HttpError(404, 'الجرد غير موجود');
      const bf = getBranchFilter(req);
      if (bf.scope === 'own' && s.branch_id !== bf.branchId) throw new HttpError(403, 'جرد فرع آخر');
      if (s.status !== 'open') throw new HttpError(400, 'هذا الجرد مغلق مسبقاً');
      let adjusted = 0, shortage = 0, surplus = 0;
      if (apply) {
        const items = (await client.query('SELECT * FROM stocktake_items WHERE stocktake_id=$1 ORDER BY product_id', [s.id])).rows;
        for (const it of items) {
          const delta = parseFloat(it.counted) - parseFloat(it.expected);
          if (delta === 0) continue;
          const p = (await client.query('SELECT * FROM products WHERE id=$1 FOR UPDATE', [it.product_id])).rows[0];
          const before = parseFloat(p.stock);
          const after = Math.max(0, before + delta);
          await client.query('UPDATE products SET stock=$1, updated_at=NOW() WHERE id=$2', [after, p.id]);
          await mov(client, req, p, 'stocktake', after - before, before, after, s.id, 'stocktake', `جرد ${s.number}`);
          adjusted++;
          const v = delta * parseFloat(p.cost_price);
          if (v < 0) shortage += -v; else surplus += v;
        }
      }
      await client.query(`UPDATE stocktakes SET status=$1, closed_by=$2, closed_at=NOW() WHERE id=$3`, [apply ? 'closed' : 'cancelled', req.user.id, s.id]);
      return { status: apply ? 'closed' : 'cancelled', adjusted, shortage_value: Math.round(shortage * 100) / 100, surplus_value: Math.round(surplus * 100) / 100 };
    });
    await logActivity(req, 'stocktake_close', 'stocktake', req.params.id, out);
    res.json({ ok: true, data: out });
  } catch (e) { next(e); }
});

// ---------- تحويل بين الفروع ----------
router.post('/transfers', requireRole(...INV), async (req, res, next) => {
  try {
    const { to_branch_id, items, notes } = req.body || {};
    if (!Array.isArray(items) || !items.length || items.length > 200) throw new HttpError(400, 'أصناف التحويل مطلوبة (حتى 200)');
    const out = await transaction(async (client) => {
      const db = { query: client.query.bind(client) };
      const from = await allowedBranch(db, req, req.body.from_branch_id);
      const to = (await client.query('SELECT id FROM branches WHERE id=$1 AND tenant_id=$2', [to_branch_id, req.tenantId])).rows[0];
      if (!to) throw new HttpError(400, 'الفرع المستلم غير موجود');
      if (to.id === from) throw new HttpError(400, 'لا يمكن التحويل إلى نفس الفرع');
      const number = await nextNumber(client, req.tenantId, 'TRF', 'TRF');
      const t = (await client.query(
        `INSERT INTO stock_transfers (tenant_id, number, from_branch_id, to_branch_id, notes, created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
        [req.tenantId, number, from, to.id, notes || null, req.user.id])).rows[0];

      // قفل بترتيب ثابت لتجنب التشابك بين تحويلات متزامنة
      const sorted = [...items].sort((a, b) => String(a.product_id).localeCompare(String(b.product_id)));
      const seen = new Set();
      for (const it of sorted) {
        if (seen.has(it.product_id)) throw new HttpError(400, 'صنف مكرر في التحويل');
        seen.add(it.product_id);
        const qty = num(it.quantity, { name: 'الكمية', min: 0.001, max: 1e9 });
        const src = (await client.query('SELECT * FROM products WHERE id=$1 AND tenant_id=$2 AND branch_id=$3 AND is_active FOR UPDATE', [it.product_id, req.tenantId, from])).rows[0];
        if (!src) throw new HttpError(404, 'منتج غير موجود في الفرع المحوِّل');
        if (src.is_service) throw new HttpError(400, `«${src.name}» خدمة`);
        const before = parseFloat(src.stock);
        if (before < qty) throw new HttpError(400, `مخزون «${src.name}» غير كافٍ (المتوفر ${before})`);

        // المنتج المقابل في الفرع المستلم: بالباركود ثم الاسم، وإلا يُنشأ
        let dst = null;
        if (src.barcode) dst = (await client.query('SELECT * FROM products WHERE tenant_id=$1 AND branch_id=$2 AND barcode=$3 AND is_active FOR UPDATE', [req.tenantId, to.id, src.barcode])).rows[0];
        if (!dst) dst = (await client.query('SELECT * FROM products WHERE tenant_id=$1 AND branch_id=$2 AND LOWER(name)=LOWER($3) AND is_active FOR UPDATE', [req.tenantId, to.id, src.name])).rows[0];
        if (!dst) {
          const cnt = (await client.query(`SELECT COUNT(*)::int n, (SELECT max_products FROM tenants WHERE id=$1) m FROM products WHERE tenant_id=$1 AND is_active`, [req.tenantId])).rows[0];
          if (cnt.n >= cnt.m) throw new HttpError(400, 'تجاوز الحد الأقصى للمنتجات');
          dst = (await client.query(
            `INSERT INTO products (tenant_id, branch_id, name, barcode, sku, category, description, sell_price, cost_price, wholesale_price, stock, min_stock, unit, tax_rate, created_by, plu, sold_by_weight)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,0,$11,$12,$13,$14,$15,$16) RETURNING *`,
            [req.tenantId, to.id, src.name, src.barcode, src.sku, src.category, src.description, src.sell_price, src.cost_price, src.wholesale_price,
              src.min_stock, src.unit, src.tax_rate, req.user.id, src.plu, src.sold_by_weight])).rows[0];
        }
        const dBefore = parseFloat(dst.stock);
        await client.query('UPDATE products SET stock = stock - $1, updated_at=NOW() WHERE id=$2', [qty, src.id]);
        await client.query('UPDATE products SET stock = stock + $1, updated_at=NOW() WHERE id=$2', [qty, dst.id]);
        await mov(client, req, src, 'transfer_out', -qty, before, before - qty, t.id, 'transfer', `تحويل ${number}`);
        await mov(client, req, dst, 'transfer_in', qty, dBefore, dBefore + qty, t.id, 'transfer', `تحويل ${number}`);
        await client.query(
          `INSERT INTO stock_transfer_items (transfer_id, from_product_id, to_product_id, quantity, unit_cost) VALUES ($1,$2,$3,$4,$5)`,
          [t.id, src.id, dst.id, qty, src.cost_price]);
      }
      return t;
    });
    await logActivity(req, 'stock_transfer', 'transfer', out.id, { number: out.number });
    res.json({ ok: true, data: out });
  } catch (e) { next(e); }
});

router.get('/transfers', requireRole(...INV, 'accountant'), async (req, res, next) => {
  try {
    const bf = getBranchFilter(req);
    const p = [req.tenantId]; let w = '';
    if (bf.filter && bf.branchId) { p.push(bf.branchId); w = ` AND (t.from_branch_id = $2 OR t.to_branch_id = $2)`; }
    const r = await query(
      `SELECT t.*, fb.name AS from_branch, tb.name AS to_branch,
              (SELECT COUNT(*) FROM stock_transfer_items i WHERE i.transfer_id = t.id)::int AS items_count,
              (SELECT COALESCE(SUM(i.quantity * i.unit_cost),0) FROM stock_transfer_items i WHERE i.transfer_id = t.id) AS total_cost
         FROM stock_transfers t JOIN branches fb ON fb.id = t.from_branch_id JOIN branches tb ON tb.id = t.to_branch_id
        WHERE t.tenant_id = $1${w} ORDER BY t.created_at DESC LIMIT 100`, p);
    res.json({ ok: true, data: r.rows });
  } catch (e) { next(e); }
});

// ---------- اقتراح إعادة الطلب ----------
router.get('/reorder', requireRole(...INV, 'accountant'), async (req, res, next) => {
  try {
    const days = Math.min(Math.max(parseInt(req.query.days) || 30, 7), 365);
    const cover = Math.min(Math.max(parseInt(req.query.cover) || 14, 1), 90);
    const bf = getBranchFilter(req);
    const p = [req.tenantId, days]; let w = '';
    if (bf.filter && bf.branchId) { p.push(bf.branchId); w = ' AND p.branch_id = $3'; }
    const r = await query(
      `SELECT p.id, p.name, p.barcode, p.unit, p.stock, p.min_stock, p.cost_price, COALESCE(s.qty, 0) AS sold,
              ls.supplier_id, ls.supplier_name
         FROM products p
         LEFT JOIN (SELECT ii.product_id, SUM(ii.quantity) AS qty FROM invoice_items ii JOIN invoices i ON i.id = ii.invoice_id
                     WHERE i.tenant_id = $1 AND i.status = 'completed' AND i.created_at >= NOW() - make_interval(days => $2)
                     GROUP BY ii.product_id) s ON s.product_id = p.id
         LEFT JOIN LATERAL (SELECT pu.supplier_id, su.name AS supplier_name FROM purchase_items pi
                              JOIN purchases pu ON pu.id = pi.purchase_id LEFT JOIN suppliers su ON su.id = pu.supplier_id
                             WHERE pi.product_id = p.id ORDER BY pu.created_at DESC LIMIT 1) ls ON TRUE
        WHERE p.tenant_id = $1 AND p.is_active AND NOT p.is_service${w}`, p);
    const rows = [];
    for (const x of r.rows) {
      const stock = parseFloat(x.stock), min = parseFloat(x.min_stock), daily = parseFloat(x.sold) / days;
      const daysLeft = daily > 0 ? stock / daily : null;
      const need = stock <= min || (daysLeft !== null && daysLeft < cover);
      if (!need) continue;
      const target = Math.max(min * 2, daily * cover);
      const qty = Math.ceil(target - stock);
      if (qty <= 0) continue;
      rows.push({ product_id: x.id, name: x.name, barcode: x.barcode, unit: x.unit, stock, min_stock: min,
        avg_daily: Math.round(daily * 100) / 100, days_left: daysLeft === null ? null : Math.round(daysLeft * 10) / 10,
        suggested_qty: qty, est_cost: Math.round(qty * parseFloat(x.cost_price) * 100) / 100,
        supplier_id: x.supplier_id, supplier_name: x.supplier_name });
    }
    rows.sort((a, b) => (a.days_left ?? 1e9) - (b.days_left ?? 1e9));
    res.json({ ok: true, data: rows, params: { days, cover }, total_est_cost: Math.round(rows.reduce((s, r) => s + r.est_cost, 0) * 100) / 100 });
  } catch (e) { next(e); }
});

module.exports = router;
