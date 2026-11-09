/** أدوات الباركود (EAN-13) — نسخة الخادم. النسخة الأمامية: public/js/barcode.js بنفس المنطق. */

function ean13Check(d12) {
  let s = 0;
  for (let i = 0; i < 12; i++) s += (+d12[i]) * (i % 2 === 0 ? 1 : 3);
  return (10 - (s % 10)) % 10;
}
function isValidEAN13(code) {
  return /^\d{13}$/.test(code) && ean13Check(code.slice(0, 12)) === +code[12];
}
/** باركود داخلي: 29 + 10 خانات (تسلسل) + خانة تحقق. البادئة 2x محجوزة للاستخدام الداخلي في المتاجر. */
function internalEAN13(seq) {
  const d12 = '29' + String(seq).padStart(10, '0');
  return d12 + ean13Check(d12);
}
/**
 * باركود الميزان: 2 + PLU(6) + الوزن بالغرام(5) + تحقق. يبدأ بـ2 ولا يبدأ بـ29 (الداخلي).
 * يعيد null إن لم يكن باركود ميزان صالحاً.
 */
function decodeScale(code) {
  if (!isValidEAN13(code) || code[0] !== '2' || code[1] === '9') return null;
  return { plu: code.slice(1, 7), grams: parseInt(code.slice(7, 12), 10) };
}
const normPlu = (v) => String(parseInt(v, 10)).padStart(6, '0');

module.exports = { ean13Check, isValidEAN13, internalEAN13, decodeScale, normPlu };

// ---------- دوال تعتمد على قاعدة البيانات ----------
/** هل الباركود مستخدم لمنتج آخر في نفس الفرع (رئيسي أو إضافي)؟ يعيد اسم المنتج المتعارض. */
async function barcodeConflict(db, tenantId, branchId, code, exceptProductId) {
  const r = await db.query(
    `SELECT name FROM products WHERE tenant_id=$1 AND branch_id=$2 AND barcode=$3 AND is_active AND ($4::uuid IS NULL OR id <> $4)
     UNION ALL
     SELECT p.name FROM product_barcodes pb JOIN products p ON p.id = pb.product_id
      WHERE pb.tenant_id=$1 AND pb.branch_id=$2 AND pb.barcode=$3 AND p.is_active AND ($4::uuid IS NULL OR p.id <> $4)
     LIMIT 1`, [tenantId, branchId, code, exceptProductId || null]);
  return r.rows.length ? r.rows[0].name : null;
}

/** البحث عن منتج بالباركود: رئيسي ← إضافي (كرتونة) ← ميزان. branchId=null يعني كل الفروع. */
async function lookupByCode(db, tenantId, branchId, code) {
  code = String(code).trim();
  const br = branchId ? ' AND p.branch_id = $3' : '';
  const params = branchId ? [tenantId, code, branchId] : [tenantId, code];
  let r = await db.query(`SELECT p.* FROM products p WHERE p.tenant_id=$1 AND p.barcode=$2 AND p.is_active${br} LIMIT 1`, params);
  if (r.rows.length) return { product: r.rows[0], qty: 1, kind: 'main' };
  r = await db.query(
    `SELECT p.*, pb.pack_qty AS _pack FROM product_barcodes pb JOIN products p ON p.id = pb.product_id
      WHERE pb.tenant_id=$1 AND pb.barcode=$2 AND p.is_active${br} LIMIT 1`, params);
  if (r.rows.length) { const { _pack, ...product } = r.rows[0]; return { product, qty: parseFloat(_pack), kind: 'pack' }; }
  const sc = decodeScale(code);
  if (sc) {
    const p2 = branchId ? [tenantId, normPlu(sc.plu), branchId] : [tenantId, normPlu(sc.plu)];
    r = await db.query(`SELECT p.* FROM products p WHERE p.tenant_id=$1 AND p.plu=$2 AND p.sold_by_weight AND p.is_active${br} LIMIT 1`, p2);
    if (r.rows.length) return { product: r.rows[0], qty: sc.grams / 1000, kind: 'scale' };
  }
  return null;
}
module.exports.barcodeConflict = barcodeConflict;
module.exports.lookupByCode = lookupByCode;
