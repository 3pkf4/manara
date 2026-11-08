/**
 * النسخ الاحتياطي الكامل + استيراد البيانات.
 *   GET  /api/data/backup                 نسخة JSON كاملة للمتجر (بدون كلمات المرور)
 *   GET  /api/data/template/:type         قالب CSV فارغ (products | customers | suppliers)
 *   POST /api/data/import/:type           { rows:[...], on_duplicate:'skip'|'update', dry_run:true|false }
 * الاستيراد يقبل رؤوس عربية أو إنجليزية، ويعيد تقريراً مفصّلاً لكل صف.
 */
const express = require('express');
const router = express.Router();
const { query, transaction } = require('../db');
const { authenticate, requireRole, checkTenantActive, requireTenant } = require('../middleware/auth');
const { resolveBranchForInsert } = require('../middleware/branch-filter');
const { toCsv, HttpError, num } = require('../lib/util');
const { logActivity } = require('../middleware/logger');

router.use(authenticate, checkTenantActive, requireTenant);
const ADMINS = ['owner', 'tenant_admin'];
const MAX_ROWS = 5000;

// ---------- أسماء الأعمدة المقبولة ----------
const ALIASES = {
  name: ['name', 'الاسم', 'اسم المنتج', 'المنتج', 'اسم العميل', 'اسم المورد'],
  barcode: ['barcode', 'الباركود', 'باركود'],
  sku: ['sku', 'رمز المنتج', 'الرمز'],
  category: ['category', 'التصنيف', 'الفئة'],
  cost_price: ['cost_price', 'سعر التكلفة', 'التكلفة', 'سعر الشراء'],
  sell_price: ['sell_price', 'سعر البيع', 'البيع', 'السعر'],
  wholesale_price: ['wholesale_price', 'سعر الجملة'],
  stock: ['stock', 'الكمية', 'المخزون'],
  min_stock: ['min_stock', 'الحد الأدنى'],
  unit: ['unit', 'الوحدة'],
  expiry_date: ['expiry_date', 'تاريخ الصلاحية', 'الصلاحية'],
  phone: ['phone', 'الهاتف', 'رقم الهاتف', 'الجوال'],
  email: ['email', 'البريد', 'البريد الإلكتروني'],
  address: ['address', 'العنوان'],
  balance: ['balance', 'الرصيد', 'الرصيد (دين)', 'الرصيد الافتتاحي'],
  credit_limit: ['credit_limit', 'سقف الدين'],
  notes: ['notes', 'ملاحظات']
};
const LOOKUP = {};
for (const [k, list] of Object.entries(ALIASES)) for (const a of list) LOOKUP[a.trim().toLowerCase()] = k;

function normalizeRow(raw) {
  const out = {};
  for (const [h, v] of Object.entries(raw || {})) {
    const key = LOOKUP[String(h).replace(/^﻿/, '').trim().toLowerCase()];
    if (key && out[key] === undefined) {
      let s = v === null || v === undefined ? '' : String(v).trim();
      if (/^'[=+\-@]/.test(s)) s = s.slice(1); // حماية الصيغ عند التصدير
      out[key] = s;
    }
  }
  return out;
}

const AR_DIGITS = { '٠': 0, '١': 1, '٢': 2, '٣': 3, '٤': 4, '٥': 5, '٦': 6, '٧': 7, '٨': 8, '٩': 9 };
function numeric(v, label, opts = {}) {
  if (v === undefined || v === '') return opts.def === undefined ? undefined : opts.def;
  const s = String(v).replace(/[٠-٩]/g, d => AR_DIGITS[d]).replace(/[,٬\s]/g, '').replace('٫', '.');
  return num(s, { name: label, min: opts.min ?? 0, max: 1e9 });
}
function dateOrNull(v) {
  if (!v) return null;
  const s = String(v).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || isNaN(Date.parse(s))) throw new HttpError(400, 'صيغة التاريخ يجب أن تكون YYYY-MM-DD');
  return s;
}
const str = (v, max = 255) => (v === undefined || v === '' ? null : String(v).slice(0, max));

// ---------- القوالب ----------
const TEMPLATES = {
  products: {
    columns: [['الباركود', 'barcode'], ['الاسم', 'name'], ['التصنيف', 'category'], ['سعر التكلفة', 'cost_price'],
      ['سعر البيع', 'sell_price'], ['الكمية', 'stock'], ['الحد الأدنى', 'min_stock'], ['الوحدة', 'unit'], ['تاريخ الصلاحية', 'expiry_date']],
    sample: { barcode: '6221000000011', name: 'مثال: عصير برتقال', category: 'مشروبات', cost_price: '1.5', sell_price: '2.25', stock: '40', min_stock: '5', unit: 'قطعة', expiry_date: '2027-06-30' }
  },
  customers: {
    columns: [['الاسم', 'name'], ['الهاتف', 'phone'], ['العنوان', 'address'], ['الرصيد (دين)', 'balance'], ['سقف الدين', 'credit_limit']],
    sample: { name: 'مثال: أحمد علي', phone: '0912345678', address: 'طرابلس', balance: '0', credit_limit: '500' }
  },
  suppliers: {
    columns: [['الاسم', 'name'], ['الهاتف', 'phone'], ['العنوان', 'address'], ['الرصيد', 'balance']],
    sample: { name: 'مثال: شركة التوريد', phone: '0923456789', address: 'مصراتة', balance: '0' }
  }
};

router.get('/template/:type', requireRole(...ADMINS, 'branch_manager', 'warehouse'), (req, res, next) => {
  try {
    const t = TEMPLATES[req.params.type];
    if (!t) throw new HttpError(404, 'نوع غير معروف');
    const columns = t.columns.map(([label, key]) => ({ label, key }));
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="template-${req.params.type}.csv"`);
    res.send(toCsv(columns, [t.sample]));
  } catch (e) { next(e); }
});

// ---------- الاستيراد ----------
const IMPORTERS = {
  async products(client, req, branchId, r, update, state) {
    if (!r.name) throw new HttpError(400, 'الاسم مطلوب');
    const sell = numeric(r.sell_price, 'سعر البيع');
    if (sell === undefined) throw new HttpError(400, 'سعر البيع مطلوب');
    const v = {
      cost: numeric(r.cost_price, 'سعر التكلفة', { def: 0 }), wholesale: numeric(r.wholesale_price, 'سعر الجملة', { def: 0 }),
      stock: numeric(r.stock, 'الكمية', { def: 0 }), min: numeric(r.min_stock, 'الحد الأدنى', { def: 5 }),
      expiry: dateOrNull(r.expiry_date)
    };
    const barcode = str(r.barcode, 100);
    const found = barcode
      ? await client.query('SELECT id FROM products WHERE tenant_id=$1 AND branch_id=$2 AND barcode=$3 AND is_active LIMIT 1', [req.tenantId, branchId, barcode])
      : await client.query('SELECT id FROM products WHERE tenant_id=$1 AND branch_id=$2 AND LOWER(name)=LOWER($3) AND is_active LIMIT 1', [req.tenantId, branchId, r.name]);
    if (found.rows.length) {
      if (!update) return 'skipped';
      await client.query(
        `UPDATE products SET name=$1, category=COALESCE($2,category), cost_price=$3, sell_price=$4, wholesale_price=$5,
                min_stock=$6, unit=COALESCE($7,unit), expiry_date=COALESCE($8,expiry_date), updated_at=NOW()
          WHERE id=$9 AND tenant_id=$10`,
        [r.name.slice(0, 255), str(r.category, 100), v.cost, sell, v.wholesale, v.min, str(r.unit, 50), v.expiry, found.rows[0].id, req.tenantId]);
      return 'updated'; // الكمية لا تُعدَّل عند التحديث كي لا تتعارض مع حركات المخزون
    }
    if (state.productCount >= state.maxProducts) throw new HttpError(400, `تجاوز الحد الأقصى للمنتجات (${state.maxProducts})`);
    await client.query(
      `INSERT INTO products (tenant_id, branch_id, name, barcode, sku, category, cost_price, sell_price, wholesale_price,
                             stock, min_stock, unit, expiry_date, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [req.tenantId, branchId, r.name.slice(0, 255), barcode, str(r.sku, 100), str(r.category, 100) || 'عام', v.cost, sell, v.wholesale,
        v.stock, v.min, str(r.unit, 50) || 'قطعة', v.expiry, req.user.id]);
    state.productCount++;
    return 'inserted';
  },

  async customers(client, req, branchId, r, update) {
    if (!r.name) throw new HttpError(400, 'الاسم مطلوب');
    const phone = str(r.phone, 50);
    const v = { balance: numeric(r.balance, 'الرصيد', { def: 0, min: -1e9 }), limit: numeric(r.credit_limit, 'سقف الدين', { def: 0 }) };
    const found = phone
      ? await client.query('SELECT id FROM customers WHERE tenant_id=$1 AND phone=$2 AND is_active LIMIT 1', [req.tenantId, phone])
      : await client.query('SELECT id FROM customers WHERE tenant_id=$1 AND LOWER(name)=LOWER($2) AND is_active LIMIT 1', [req.tenantId, r.name]);
    if (found.rows.length) {
      if (!update) return 'skipped';
      await client.query('UPDATE customers SET name=$1, address=COALESCE($2,address), credit_limit=$3, updated_at=NOW() WHERE id=$4 AND tenant_id=$5',
        [r.name.slice(0, 255), str(r.address, 500), v.limit, found.rows[0].id, req.tenantId]);
      return 'updated'; // الرصيد لا يُعدَّل بالاستيراد؛ يتغيّر فقط بالفواتير والتحصيل
    }
    await client.query(
      `INSERT INTO customers (tenant_id, branch_id, name, phone, email, address, balance, credit_limit)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [req.tenantId, branchId, r.name.slice(0, 255), phone, str(r.email, 255), str(r.address, 500), v.balance, v.limit]);
    return 'inserted';
  },

  async suppliers(client, req, branchId, r, update) {
    if (!r.name) throw new HttpError(400, 'الاسم مطلوب');
    const balance = numeric(r.balance, 'الرصيد', { def: 0, min: -1e9 });
    const found = await client.query('SELECT id FROM suppliers WHERE tenant_id=$1 AND LOWER(name)=LOWER($2) AND is_active LIMIT 1', [req.tenantId, r.name]);
    if (found.rows.length) {
      if (!update) return 'skipped';
      await client.query('UPDATE suppliers SET phone=COALESCE($1,phone), address=COALESCE($2,address), updated_at=NOW() WHERE id=$3 AND tenant_id=$4',
        [str(r.phone, 50), str(r.address, 500), found.rows[0].id, req.tenantId]);
      return 'updated';
    }
    await client.query(
      `INSERT INTO suppliers (tenant_id, branch_id, name, phone, email, address, balance) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [req.tenantId, branchId, r.name.slice(0, 255), str(r.phone, 50), str(r.email, 255), str(r.address, 500), balance]);
    return 'inserted';
  }
};

router.post('/import/:type', requireRole(...ADMINS, 'branch_manager', 'warehouse'), async (req, res, next) => {
  try {
    const importer = IMPORTERS[req.params.type];
    if (!importer) throw new HttpError(404, 'نوع الاستيراد غير معروف. المتاح: ' + Object.keys(IMPORTERS).join(', '));
    const rows = req.body && req.body.rows;
    if (!Array.isArray(rows) || !rows.length) throw new HttpError(400, 'لا توجد صفوف للاستيراد');
    if (rows.length > MAX_ROWS) throw new HttpError(400, `الحد الأقصى ${MAX_ROWS} صف في المرة الواحدة`);
    const update = req.body.on_duplicate === 'update';
    const dry = req.body.dry_run === true;

    const branchId = await resolveBranchForInsert(req, query);
    if (!branchId) throw new HttpError(400, 'يجب تحديد الفرع');

    const report = { inserted: 0, updated: 0, skipped: 0, errors: [], dry_run: dry };
    await transaction(async (client) => {
      const br = await client.query('SELECT 1 FROM branches WHERE id=$1 AND tenant_id=$2', [branchId, req.tenantId]);
      if (!br.rows.length) throw new HttpError(400, 'الفرع غير موجود');
      const lim = await client.query(
        `SELECT t.max_products, (SELECT COUNT(*) FROM products WHERE tenant_id=t.id AND is_active)::int AS n FROM tenants t WHERE t.id=$1`, [req.tenantId]);
      const state = { maxProducts: lim.rows[0].max_products, productCount: lim.rows[0].n };

      for (let i = 0; i < rows.length; i++) {
        const row = normalizeRow(rows[i]);
        await client.query('SAVEPOINT r');
        try {
          if (!Object.keys(row).length) throw new HttpError(400, 'صف فارغ أو أعمدة غير معروفة');
          const result = await importer(client, req, branchId, row, update, state);
          report[result]++;
          await client.query('RELEASE SAVEPOINT r');
        } catch (e) {
          await client.query('ROLLBACK TO SAVEPOINT r');
          report.errors.push({ row: i + 2, error: e instanceof HttpError ? e.message : 'بيانات غير صالحة' }); // i+2: الصف 1 هو الرأس
        }
      }
      if (dry) throw Object.assign(new Error('dry'), { dry: true });
    }).catch(e => { if (!e.dry) throw e; });

    if (!dry) await logActivity(req, 'import_' + req.params.type, 'import', null, { inserted: report.inserted, updated: report.updated, errors: report.errors.length });
    res.json({ ok: true, data: report });
  } catch (e) { next(e); }
});

// ---------- نسخة احتياطية كاملة ----------
router.get('/backup', requireRole(...ADMINS), async (req, res, next) => {
  try {
    const t = req.tenantId;
    const q = async (sql) => (await query(sql, [t])).rows;
    const data = {
      meta: { app: 'manara-pos', format: 1, exported_at: new Date().toISOString() },
      tenant: (await query(
        'SELECT tenant_code, business_name, owner_name, owner_phone, address, currency, plan FROM tenants WHERE id=$1', [t])).rows[0],
      branches: await q('SELECT * FROM branches WHERE tenant_id=$1'),
      products: await q('SELECT * FROM products WHERE tenant_id=$1 ORDER BY name'),
      customers: await q('SELECT * FROM customers WHERE tenant_id=$1 ORDER BY name'),
      suppliers: await q('SELECT * FROM suppliers WHERE tenant_id=$1 ORDER BY name'),
      expenses: await q('SELECT * FROM expenses WHERE tenant_id=$1 ORDER BY created_at'),
      invoices: await q('SELECT * FROM invoices WHERE tenant_id=$1 ORDER BY created_at'),
      invoice_items: await q('SELECT ii.* FROM invoice_items ii JOIN invoices i ON i.id = ii.invoice_id WHERE i.tenant_id=$1'),
      purchases: await q('SELECT * FROM purchases WHERE tenant_id=$1 ORDER BY created_at'),
      settings: await q('SELECT setting_key, setting_value FROM tenant_settings WHERE tenant_id=$1'),
      users: await q('SELECT username, full_name, role, branch_id, is_active FROM users WHERE tenant_id=$1') // بدون كلمات المرور
    };
    await logActivity(req, 'export_backup', 'export', null, { invoices: data.invoices.length });
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="manara-backup-${new Date().toISOString().slice(0, 10)}.json"`);
    res.send(JSON.stringify(data));
  } catch (e) { next(e); }
});

module.exports = router;
