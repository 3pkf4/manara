const express = require('express');
const router = express.Router();
const { query, transaction } = require('../db');
const { authenticate, requireRole, checkTenantActive, requireTenant } = require('../middleware/auth');
const { logActivity } = require('../middleware/logger');
const { getBranchFilter } = require('../middleware/branch-filter');
const bcrypt = require('bcryptjs');
const { PROMO_LATERAL } = require('../lib/promo');
const { HttpError, num, round2, round3, nextNumber, getSettings, truthy, normalizePhoneLY } = require('../lib/util');

router.use(authenticate, checkTenantActive, requireTenant);

const PAYMENT_TYPES = ['cash', 'card', 'transfer', 'credit', 'split'];
const MANAGER_ROLES = ['owner', 'tenant_admin', 'branch_manager', 'accountant'];
const isUuid = (v) => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);

// ---- اعتماد المدير (رمز/كلمة مرور) لتجاوز حدود الكاشير ----
const approvalFails = new Map(); // tenant:username -> {n, until}
const APPROVER_ROLES = ['owner', 'tenant_admin', 'branch_manager'];
async function verifyApprover(client, tenantId, branchId, ap) {
  const username = String(ap && ap.username || '').trim().toLowerCase();
  const password = String(ap && ap.password || '');
  if (!username || !password) throw new HttpError(400, 'بيانات اعتماد المدير ناقصة');
  const key = tenantId + ':' + username;
  const f = approvalFails.get(key);
  if (f && f.n >= 5 && f.until > Date.now()) throw new HttpError(429, 'محاولات اعتماد كثيرة، حاول بعد دقائق');
  const r = await client.query(
    'SELECT id, password_hash, role, branch_id FROM users WHERE tenant_id = $1 AND LOWER(username) = $2 AND is_active', [tenantId, username]);
  const u = r.rows[0];
  const good = u && await bcrypt.compare(password, u.password_hash) && APPROVER_ROLES.includes(u.role) &&
    (u.role !== 'branch_manager' || u.branch_id === branchId);
  if (!good) {
    const n = (f && f.until > Date.now() ? f.n : 0) + 1;
    approvalFails.set(key, { n, until: Date.now() + 10 * 60 * 1000 });
    throw new HttpError(403, 'بيانات اعتماد المدير غير صحيحة أو لا يملك الصلاحية', 'APPROVAL_DENIED');
  }
  approvalFails.delete(key);
  return u.id;
}

/** الفرع الفعلي للعملية: فرع المستخدم، أو (للمدير) الفرع المرسل/الرئيسي */
async function effectiveBranchId(req, client) {
  if (req.branchId) return req.branchId;
  if (['owner', 'tenant_admin'].includes(req.user.role)) {
    const wanted = req.body && req.body.branch_id;
    if (wanted) {
      if (!isUuid(wanted)) throw new HttpError(400, 'معرّف الفرع غير صالح');
      return wanted;
    }
    const main = await client.query(
      'SELECT id FROM branches WHERE tenant_id = $1 AND is_main = TRUE LIMIT 1', [req.tenantId]);
    if (main.rows.length) return main.rows[0].id;
  }
  throw new HttpError(400, 'لا يوجد فرع مرتبط بحسابك');
}

// ============================================
// جلب الفواتير
// ============================================
router.get('/', async (req, res, next) => {
  try {
    const { from, to, customer_id, payment_type, status } = req.query;
    const limit = Math.min(500, Math.max(1, parseInt(req.query.limit) || 100));
    const bf = getBranchFilter(req);
    let sql = `SELECT i.*, u.full_name AS cashier_name, b.name AS branch_name
               FROM invoices i
               LEFT JOIN users u ON u.id = i.user_id
               LEFT JOIN branches b ON b.id = i.branch_id
               WHERE i.tenant_id = $1`;
    const params = [req.tenantId];
    let p = 2;
    if (bf.filter && bf.branchId) { sql += ` AND i.branch_id = $${p}`; params.push(bf.branchId); p++; }
    if (from) { sql += ` AND i.created_at >= $${p}`; params.push(from); p++; }
    if (to) { sql += ` AND i.created_at < $${p}::date + INTERVAL '1 day'`; params.push(to); p++; }
    if (customer_id) { sql += ` AND i.customer_id = $${p}`; params.push(customer_id); p++; }
    if (payment_type) { sql += ` AND i.payment_type = $${p}`; params.push(payment_type); p++; }
    if (status) { sql += ` AND i.status = $${p}`; params.push(status); p++; }
    sql += ` ORDER BY i.created_at DESC LIMIT $${p}`;
    params.push(limit);
    const r = await query(sql, params);
    res.json({ ok: true, data: r.rows });
  } catch (e) { next(e); }
});

async function loadInvoice(req, id) {
  if (!isUuid(id)) return null;
  const inv = await query(
    `SELECT i.*, u.full_name AS cashier_name,
            b.name AS branch_name, b.address AS branch_address, b.phone AS branch_phone,
            t.business_name, t.address AS tenant_address, t.owner_phone AS tenant_phone,
            c.phone AS customer_phone
       FROM invoices i
       LEFT JOIN users u ON u.id = i.user_id
       LEFT JOIN branches b ON b.id = i.branch_id
       LEFT JOIN tenants t ON t.id = i.tenant_id
       LEFT JOIN customers c ON c.id = i.customer_id
      WHERE i.id = $1 AND i.tenant_id = $2`,
    [id, req.tenantId]);
  if (!inv.rows.length) return null;
  const bf = getBranchFilter(req);
  if (bf.filter && bf.branchId && inv.rows[0].branch_id !== bf.branchId) return null;
  const items = await query('SELECT * FROM invoice_items WHERE invoice_id = $1 ORDER BY created_at', [id]);
  return { ...inv.rows[0], items: items.rows };
}

router.get('/:id', async (req, res, next) => {
  try {
    const inv = await loadInvoice(req, req.params.id);
    if (!inv) return res.status(404).json({ ok: false, error: 'الفاتورة غير موجودة' });
    res.json({ ok: true, data: inv });
  } catch (e) { next(e); }
});

// ============================================
// 📲 مشاركة الفاتورة عبر واتساب (نص جاهز + رابط wa.me)
// ============================================
router.get('/:id/share', async (req, res, next) => {
  try {
    const inv = await loadInvoice(req, req.params.id);
    if (!inv) return res.status(404).json({ ok: false, error: 'الفاتورة غير موجودة' });
    const s = await getSettings({ query }, req.tenantId).catch(() => ({}));
    const fmt = (n) => round2(parseFloat(n) || 0).toFixed(2);
    const lines = [
      `*${inv.business_name}*`,
      `فاتورة رقم: ${inv.invoice_number}`,
      `التاريخ: ${new Date(inv.created_at).toLocaleString('ar-LY', { timeZone: 'Africa/Tripoli' })}`,
      inv.customer_name ? `العميل: ${inv.customer_name}` : null,
      '------------------------',
      ...inv.items.map(it => `${it.product_name} × ${parseFloat(it.quantity)} = ${fmt(it.total)}`),
      '------------------------',
      parseFloat(inv.discount_amount) > 0 ? `الخصم: ${fmt(inv.discount_amount)}` : null,
      `*الإجمالي: ${fmt(inv.total)}*`,
      `المدفوع: ${fmt(inv.paid)}`,
      parseFloat(inv.remaining) > 0 ? `المتبقي: ${fmt(inv.remaining)}` : null,
      inv.status === 'cancelled' ? '⚠️ هذه الفاتورة ملغاة' : null,
      s.print_footer || 'شكراً لزيارتكم'
    ].filter(Boolean);
    const text = lines.join('\n');
    const phone = normalizePhoneLY(req.query.phone || inv.customer_phone);
    res.json({
      ok: true,
      data: {
        text,
        phone,
        whatsapp_url: phone
          ? `https://wa.me/${phone}?text=${encodeURIComponent(text)}`
          : `https://wa.me/?text=${encodeURIComponent(text)}`
      }
    });
  } catch (e) { next(e); }
});

// ============================================
// إنشاء فاتورة بيع جديدة
// ============================================
router.post('/', async (req, res, next) => {
  try {
    const b = req.body || {};
    const items = b.items;
    if (!Array.isArray(items) || items.length === 0) throw new HttpError(400, 'الفاتورة فارغة');
    if (items.length > 300) throw new HttpError(400, 'عدد البنود كبير جداً');

    const paymentType = b.payment_type === undefined ? 'cash' : b.payment_type;
    if (!PAYMENT_TYPES.includes(paymentType)) throw new HttpError(400, 'طريقة الدفع غير صالحة');
    const customerId = b.customer_id || null;
    if (customerId && !isUuid(customerId)) throw new HttpError(400, 'معرّف العميل غير صالح');
    const localId = b.local_id ? String(b.local_id).slice(0, 100) : null;
    const notes = b.notes ? String(b.notes).slice(0, 1000) : null;

    // رقم الفاتورة المحلي (وضع عدم الاتصال): إعادة الإرسال لا تُنشئ فاتورة ثانية
    if (localId) {
      const dup = await query('SELECT * FROM invoices WHERE tenant_id = $1 AND local_id = $2', [req.tenantId, localId]);
      if (dup.rows.length) return res.json({ ok: true, data: dup.rows[0], duplicate: true });
    }

    const result = await transaction(async (client) => {
      const settings = await getSettings(client, req.tenantId);
      let isManager = MANAGER_ROLES.includes(req.user.role);
      const maxDiscPct = num(settings.cashier_max_discount_percent, { name: 'الحد الأقصى للخصم', min: 0, max: 100, def: 10 });

      // ---- الفرع والوردية ----
      const branchId = await effectiveBranchId(req, client);
      const br = await client.query('SELECT id FROM branches WHERE id = $1 AND tenant_id = $2', [branchId, req.tenantId]);
      if (!br.rows.length) throw new HttpError(400, 'الفرع غير موجود');

      let approvedBy = null;
      if (b.approver && !isManager) {
        approvedBy = await verifyApprover(client, req.tenantId, branchId, b.approver);
        isManager = true; // اعتُمد من مدير: تُرفع حدود الخصم والسعر لهذه الفاتورة فقط
      }

      const shift = await client.query("SELECT id FROM shifts WHERE user_id = $1 AND status = 'open'", [req.user.id]);
      if (truthy(settings.require_shift) && req.user.role === 'cashier' && !shift.rows.length) {
        throw new HttpError(400, 'افتح وردية أولاً قبل البيع', 'SHIFT_REQUIRED');
      }
      const shiftId = shift.rows.length ? shift.rows[0].id : null;

      // ---- المنتجات: قفل الصفوف بترتيب ثابت لمنع التشابك (deadlock) ----
      const ids = [...new Set(items.map(it => it && it.product_id))];
      if (ids.some(id => !isUuid(id))) throw new HttpError(400, 'معرّف منتج غير صالح');
      const prodRes = await client.query(
        `SELECT p.*, promo.price AS promo_price FROM products p ${PROMO_LATERAL}
          WHERE p.id = ANY($1::uuid[]) AND p.tenant_id = $2 ORDER BY p.id FOR UPDATE OF p`,
        [ids, req.tenantId]);
      const products = new Map(prodRes.rows.map(p => [p.id, p]));

      let subtotal = 0;
      let totalCost = 0;
      const needed = new Map(); // product_id -> total qty
      const lines = [];

      for (const it of items) {
        const product = products.get(it.product_id);
        if (!product) throw new HttpError(400, 'منتج غير موجود');
        if (!product.is_active) throw new HttpError(400, `المنتج "${product.name}" غير مفعّل`);
        if (product.branch_id && product.branch_id !== branchId) {
          throw new HttpError(400, `المنتج "${product.name}" غير متوفر في هذا الفرع`);
        }
        const qty = round3(num(it.qty, { name: 'الكمية', min: 0.001, max: 1000000 }));
        const sell = product.promo_price !== null && product.promo_price !== undefined ? parseFloat(product.promo_price) : parseFloat(product.sell_price); // سعر العرض الفعّال
        const price = round2(it.unit_price === undefined || it.unit_price === null || it.unit_price === ''
          ? sell : num(it.unit_price, { name: 'السعر', min: 0.01, max: 100000000 }));

        // الكاشير لا يبيع بأقل من (سعر الجملة/البيع − نسبة الخصم المسموحة)
        if (!isManager) {
          const wholesale = parseFloat(product.wholesale_price) || 0;
          const base = Math.min(sell, wholesale > 0 ? wholesale : sell);
          const floor = round2(base * (1 - maxDiscPct / 100));
          if (price + 0.0001 < floor) {
            throw new HttpError(403, `السعر أقل من الحد المسموح للمنتج "${product.name}" (الأدنى ${floor})`, 'PRICE_BELOW_MIN');
          }
        }
        needed.set(product.id, (needed.get(product.id) || 0) + qty);
        const lineTotal = round2(qty * price);
        subtotal += lineTotal;
        totalCost += qty * (parseFloat(product.cost_price) || 0);
        lines.push({ product, qty, price, lineTotal });
      }

      for (const [pid, q] of needed) {
        const p = products.get(pid);
        if (!p.is_service && parseFloat(p.stock) + 1e-9 < q) {
          throw new HttpError(400, `مخزون "${p.name}" غير كافٍ (متوفر: ${parseFloat(p.stock)})`, 'INSUFFICIENT_STOCK');
        }
      }
      subtotal = round2(subtotal);
      totalCost = round2(totalCost);

      // ---- العميل (قفل صفه لمنع تجاوز سقف الدين بطلبين متزامنين) ----
      let customer = null;
      if (customerId) {
        const c = await client.query(
          'SELECT * FROM customers WHERE id = $1 AND tenant_id = $2 FOR UPDATE', [customerId, req.tenantId]);
        if (!c.rows.length) throw new HttpError(400, 'العميل غير موجود');
        customer = c.rows[0];
      }

      // ---- الخصم ----
      const discountAmt = num(b.discount, { name: 'الخصم', min: 0, max: 100000000, def: 0 });
      const discountPct = num(b.discount_percent, { name: 'نسبة الخصم', min: 0, max: 100, def: 0 });
      let finalDiscount = Math.min(subtotal, round2(discountAmt + subtotal * discountPct / 100));
      if (!isManager && subtotal > 0 && (finalDiscount / subtotal) * 100 > maxDiscPct + 0.0001) {
        throw new HttpError(403, `الخصم يتجاوز الحد المسموح للكاشير (${maxDiscPct}%)`, 'DISCOUNT_ABOVE_MAX');
      }

      // ---- استبدال نقاط الولاء ----
      const loyaltyOn = truthy(settings.loyalty_enabled) && customer;
      let pointsRedeemed = 0;
      if (b.redeem_points && loyaltyOn) {
        const want = Math.floor(num(b.redeem_points, { name: 'النقاط', min: 0, max: 100000000 }));
        const value = num(settings.loyalty_redeem_value, { name: 'قيمة النقطة', min: 0.001, max: 1000, def: 0.1 });
        const maxByAmount = Math.floor(Math.max(0, subtotal - finalDiscount) / value);
        pointsRedeemed = Math.max(0, Math.min(want, customer.points, maxByAmount));
        finalDiscount = round2(finalDiscount + pointsRedeemed * value);
      }

      const total = round2(Math.max(0, subtotal - finalDiscount));

      // ---- الدفع ----
      const details = (b.payment_details && typeof b.payment_details === 'object') ? b.payment_details : {};
      let paid;
      if (paymentType === 'credit') {
        paid = num(b.paid, { name: 'المدفوع', min: 0, max: 100000000, def: 0 });
      } else {
        paid = num(b.paid, { name: 'المدفوع', min: 0, max: 100000000, def: total });
      }
      paid = round2(paid);

      let cashPart = 0, cardPart = 0, transferPart = 0;
      if (paymentType === 'cash') cashPart = paid;
      else if (paymentType === 'card') cardPart = paid;
      else if (paymentType === 'transfer') transferPart = paid;
      else if (paymentType === 'split') {
        cashPart = round2(num(details.cash, { name: 'المبلغ النقدي', min: 0, max: 100000000, def: 0 }));
        cardPart = round2(num(details.card, { name: 'مبلغ البطاقة', min: 0, max: 100000000, def: 0 }));
        transferPart = round2(num(details.transfer, { name: 'مبلغ الحوالة', min: 0, max: 100000000, def: 0 }));
        if (Math.abs(cashPart + cardPart + transferPart - paid) > 0.01) {
          throw new HttpError(400, 'مجموع أجزاء الدفع لا يساوي المدفوع');
        }
      } else if (paymentType === 'credit') {
        cashPart = paid; // دفعة مقدّمة نقداً
      }

      const noncash = cardPart + transferPart;
      if (noncash > total + 0.009) throw new HttpError(400, 'مبلغ البطاقة/الحوالة يتجاوز إجمالي الفاتورة');
      const change = round2(Math.max(0, paid - total));
      if (change > cashPart + 0.009) throw new HttpError(400, 'الباقي للزبون لا يمكن أن يتجاوز المبلغ النقدي');
      const paidApplied = round2(Math.min(paid, total));
      const remaining = round2(total - paidApplied);
      const drawerDelta = round2(cashPart - change);

      if (remaining > 0.009) {
        if (!customer) throw new HttpError(400, 'البيع الآجل يتطلب تحديد عميل');
        const newBalance = parseFloat(customer.balance) + remaining;
        const limit = parseFloat(customer.credit_limit) || 0;
        if (limit > 0 && newBalance > limit + 0.0001) {
          throw new HttpError(400, `تجاوز سقف الدين المسموح (${limit})`, 'CREDIT_LIMIT');
        }
      }

      // ---- نقاط مكتسبة ----
      let pointsEarned = 0;
      if (loyaltyOn) {
        const per = num(settings.loyalty_spend_per_point, { name: 'الإنفاق لكل نقطة', min: 0.01, max: 1000000, def: 10 });
        pointsEarned = Math.floor(paidApplied / per);
      }

      // ---- الفاتورة ----
      const invoiceNumber = await nextNumber(client, req.tenantId, 'INV', 'INV');
      const payDetails = { cash: cashPart, card: cardPart, transfer: transferPart, change };
      const invRes = await client.query(
        `INSERT INTO invoices (
           tenant_id, branch_id, user_id, invoice_number, customer_id, customer_name,
           subtotal, discount_amount, discount_percent, total, paid, remaining,
           payment_type, payment_details, total_cost, profit, status, notes, local_id,
           change_amount, points_earned, points_redeemed, shift_id, approved_by, synced_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,'completed',$17,$18,$19,$20,$21,$22,$23,NOW())
         RETURNING *`,
        [req.tenantId, branchId, req.user.id, invoiceNumber, customerId,
         customer ? customer.name : 'زبون نقدي',
         subtotal, finalDiscount, discountPct, total, paidApplied, remaining,
         paymentType, JSON.stringify(payDetails), totalCost, round2(total - totalCost), notes, localId,
         change, pointsEarned, pointsRedeemed, shiftId, approvedBy]
      );
      const invoice = invRes.rows[0];

      // ---- البنود + المخزون ----
      for (const ln of lines) {
        const p = ln.product;
        await client.query(
          `INSERT INTO invoice_items (invoice_id, product_id, product_name, quantity, unit_price, unit_cost, discount, total)
           VALUES ($1,$2,$3,$4,$5,$6,0,$7)`,
          [invoice.id, p.id, p.name, ln.qty, ln.price, parseFloat(p.cost_price) || 0, ln.lineTotal]);

        if (!p.is_service) {
          const st = await client.query(
            'UPDATE products SET stock = stock - $1, updated_at = NOW() WHERE id = $2 RETURNING stock',
            [ln.qty, p.id]);
          const after = parseFloat(st.rows[0].stock);
          await client.query(
            `INSERT INTO stock_movements (tenant_id, branch_id, product_id, user_id, movement_type, quantity,
                                          stock_before, stock_after, reference_id, reference_type)
             VALUES ($1,$2,$3,$4,'sale',$5,$6,$7,$8,'invoice')`,
            [req.tenantId, branchId, p.id, req.user.id, -ln.qty, round3(after + ln.qty), after, invoice.id]);
        }
      }

      // ---- العميل: الدين + النقاط ----
      if (customer && (remaining > 0.009 || pointsEarned || pointsRedeemed)) {
        await client.query(
          'UPDATE customers SET balance = balance + $1, points = points + $2 - $3, updated_at = NOW() WHERE id = $4',
          [remaining, pointsEarned, pointsRedeemed, customer.id]);
      }

      // ---- الخزينة: النقد الصافي فقط ----
      if (Math.abs(drawerDelta) > 0.0001) {
        const bal = await client.query(
          'UPDATE branches SET cash_balance = cash_balance + $1 WHERE id = $2 RETURNING cash_balance',
          [drawerDelta, branchId]);
        const after = parseFloat(bal.rows[0].cash_balance);
        await client.query(
          `INSERT INTO cash_transactions (tenant_id, branch_id, user_id, transaction_type, amount,
                                          balance_before, balance_after, reference_id, reference_type, description)
           VALUES ($1,$2,$3,'sale',$4,$5,$6,$7,'invoice',$8)`,
          [req.tenantId, branchId, req.user.id, drawerDelta, round2(after - drawerDelta), after, invoice.id,
           `فاتورة ${invoiceNumber}`]);
      }

      return invoice;
    });

    await logActivity(req, 'create_invoice', 'invoice', result.id,
      { invoice_number: result.invoice_number, total: result.total });
    res.json({ ok: true, data: result });
  } catch (e) {
    // تزامن نادر: نفس local_id وصل مرتين في نفس اللحظة
    if (e.code === '23505' && /uq_invoices_local/.test(e.message || '') && req.body && req.body.local_id) {
      const dup = await query('SELECT * FROM invoices WHERE tenant_id = $1 AND local_id = $2',
        [req.tenantId, String(req.body.local_id).slice(0, 100)]).catch(() => null);
      if (dup && dup.rows.length) return res.json({ ok: true, data: dup.rows[0], duplicate: true });
    }
    next(e);
  }
});

// ============================================
// إلغاء فاتورة (إرجاع كامل) — يعكس المخزون والدين والنقاط والخزينة
// ============================================
router.post('/:id/cancel', requireRole('owner', 'tenant_admin', 'branch_manager'), async (req, res, next) => {
  try {
    if (!isUuid(req.params.id)) throw new HttpError(404, 'الفاتورة غير موجودة');
    const reason = req.body && req.body.reason ? String(req.body.reason).slice(0, 300) : null;

    await transaction(async (client) => {
      const invRes = await client.query(
        'SELECT * FROM invoices WHERE id = $1 AND tenant_id = $2 FOR UPDATE', [req.params.id, req.tenantId]);
      if (!invRes.rows.length) throw new HttpError(404, 'الفاتورة غير موجودة');
      const invoice = invRes.rows[0];

      if (req.user.role === 'branch_manager' && invoice.branch_id !== req.branchId) {
        throw new HttpError(403, 'لا تملك صلاحية على فواتير فرع آخر');
      }
      if (invoice.status === 'cancelled') throw new HttpError(400, 'الفاتورة ملغاة مسبقاً');

      const hasReturns = await client.query('SELECT 1 FROM returns WHERE invoice_id = $1 LIMIT 1', [invoice.id]);
      if (hasReturns.rows.length) throw new HttpError(400, 'للفاتورة مرتجعات مسجلة ولا يمكن إلغاؤها بالكامل');

      const items = await client.query('SELECT * FROM invoice_items WHERE invoice_id = $1 ORDER BY product_id', [invoice.id]);
      const ids = items.rows.map(i => i.product_id).filter(Boolean);
      const prods = ids.length
        ? await client.query('SELECT id, is_service FROM products WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE', [ids])
        : { rows: [] };
      const svc = new Map(prods.rows.map(p => [p.id, p.is_service]));

      for (const item of items.rows) {
        if (item.product_id && svc.has(item.product_id) && !svc.get(item.product_id)) {
          const st = await client.query(
            'UPDATE products SET stock = stock + $1, updated_at = NOW() WHERE id = $2 RETURNING stock',
            [item.quantity, item.product_id]);
          const after = parseFloat(st.rows[0].stock);
          await client.query(
            `INSERT INTO stock_movements (tenant_id, branch_id, product_id, user_id, movement_type, quantity,
                                          stock_before, stock_after, reference_id, reference_type, notes)
             VALUES ($1,$2,$3,$4,'cancel',$5,$6,$7,$8,'cancel',$9)`,
            [req.tenantId, invoice.branch_id, item.product_id, req.user.id, item.quantity,
             round3(after - parseFloat(item.quantity)), after, invoice.id, reason || 'إلغاء فاتورة']);
        }
      }

      // الدين والنقاط
      if (invoice.customer_id) {
        await client.query(
          `UPDATE customers SET balance = balance - $1,
                  points = GREATEST(0, points - $2 + $3), updated_at = NOW()
            WHERE id = $4 AND tenant_id = $5`,
          [invoice.remaining, invoice.points_earned || 0, invoice.points_redeemed || 0, invoice.customer_id, req.tenantId]);
      }

      // الخزينة: نعكس صافي النقد الذي دخل عند البيع
      const cashRows = await client.query(
        `SELECT COALESCE(SUM(amount), 0) AS net FROM cash_transactions
          WHERE reference_id = $1 AND reference_type = 'invoice' AND transaction_type = 'sale'`, [invoice.id]);
      const net = parseFloat(cashRows.rows[0].net);
      if (Math.abs(net) > 0.0001) {
        const bal = await client.query(
          'UPDATE branches SET cash_balance = cash_balance - $1 WHERE id = $2 RETURNING cash_balance',
          [net, invoice.branch_id]);
        const after = parseFloat(bal.rows[0].cash_balance);
        await client.query(
          `INSERT INTO cash_transactions (tenant_id, branch_id, user_id, transaction_type, amount,
                                          balance_before, balance_after, reference_id, reference_type, description)
           VALUES ($1,$2,$3,'cancel',$4,$5,$6,$7,'invoice',$8)`,
          [req.tenantId, invoice.branch_id, req.user.id, -net, round2(after + net), after, invoice.id,
           `إلغاء فاتورة ${invoice.invoice_number}`]);
      }

      await client.query(
        `UPDATE invoices SET status = 'cancelled', cancelled_at = NOW(), cancelled_by = $2,
                notes = COALESCE(notes, '') || $3
          WHERE id = $1`,
        [invoice.id, req.user.id, `\n[ملغاة: ${reason || 'بدون سبب'}]`]);
    });

    await logActivity(req, 'cancel_invoice', 'invoice', req.params.id, { reason });
    res.json({ ok: true, message: 'تم إلغاء الفاتورة' });
  } catch (e) { next(e); }
});

// ============================================
// تقرير سريع لليوم
// ============================================
router.get('/stats/today', async (req, res, next) => {
  try {
    const bf = getBranchFilter(req);
    const params = [req.tenantId];
    let extra = '';
    if (bf.filter && bf.branchId) { params.push(bf.branchId); extra = ' AND branch_id = $2'; }
    const r = await query(
      `SELECT COUNT(*) AS invoice_count,
              COALESCE(SUM(total), 0) AS total_sales,
              COALESCE(SUM(profit), 0) AS total_profit,
              COALESCE(SUM(paid), 0) AS total_paid,
              COALESCE(SUM(remaining), 0) AS total_remaining
         FROM invoices
        WHERE tenant_id = $1 AND status = 'completed' AND created_at >= CURRENT_DATE ${extra}`, params);
    res.json({ ok: true, data: r.rows[0] });
  } catch (e) { next(e); }
});

module.exports = router;
