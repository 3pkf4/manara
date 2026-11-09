/**
 * اختبار تكاملي: يشغّل التطبيق فعلياً على قاعدة بيانات حقيقية ويتحقق من السلوك.
 * التشغيل:  TEST_DB_ADMIN_URL=... npm test   (راجع README)
 */
process.env.NODE_ENV = 'test';
const path = require('path');
const { Pool } = require('pg');

const DB = {
  host: process.env.DB_HOST, port: parseInt(process.env.DB_PORT) || 5432,
  user: process.env.DB_USER, password: process.env.DB_PASSWORD || undefined
};
const NAME = process.env.DB_NAME || 'manara_test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_0123456789_0123456789_0123456789_abcdef';
process.env.DB_NAME = NAME;

let passed = 0, failed = 0;
const failures = [];
function ok(cond, name, extra) {
  if (cond) { passed++; console.log('  ✅', name); }
  else { failed++; failures.push(name); console.log('  ❌', name, extra !== undefined ? JSON.stringify(extra) : ''); }
}
const near = (a, b) => Math.abs(parseFloat(a) - b) < 0.011;

(async () => {
  // قاعدة نظيفة
  const admin = new Pool({ ...DB, database: 'postgres' });
  await admin.query(`DROP DATABASE IF EXISTS ${NAME}`);
  await admin.query(`CREATE DATABASE ${NAME}`);
  await admin.end();

  const { pool } = require('../server/db');
  const { migrate } = require('../server/database/migrate');
  await migrate(pool, () => {});
  const { createApp } = require('../server/server');
  const server = createApp().listen(0, '127.0.0.1');
  await new Promise(r => server.on('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  async function call(method, url, body, token, extraHeaders = {}) {
    const res = await fetch(base + url, {
      method,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}), ...extraHeaders },
      body: body ? JSON.stringify(body) : undefined
    });
    const text = await res.text();
    let json; try { json = JSON.parse(text); } catch { json = { raw: text }; }
    return { status: res.status, body: json, headers: res.headers, text };
  }
  const q = (sql, p) => pool.query(sql, p).then(r => r.rows);

  // ============ الإعداد + الدخول ============
  console.log('\n● الإعداد الأولي والدخول');
  const tok = (await q('SELECT setup_token FROM system_setup WHERE id=1'))[0].setup_token;
  let r = await call('POST', '/api/setup/init', { token: 'wrong', business_name: 'متجر أ', owner_name: 'م', owner_phone: '0910000000', admin_username: 'admin', admin_password: 'Str0ng!Pass1' });
  ok(r.status === 403, 'رمز الإعداد الخاطئ مرفوض', r.status);
  r = await call('POST', '/api/setup/init', { token: tok, business_name: 'متجر أ', owner_name: 'م', owner_phone: '0910000000', admin_username: 'admin', admin_password: '12345678' });
  ok(r.status === 400, 'كلمة مرور ضعيفة مرفوضة في الإعداد', r.body);
  r = await call('POST', '/api/setup/init', { token: tok, business_name: 'متجر أ', owner_name: 'م', owner_phone: '0910000000', admin_username: 'admin', admin_password: 'Str0ng!Pass1' });
  ok(r.status === 200 && r.body.ok, 'الإعداد الأولي ينجح', r.body);
  const adminTok = r.body.token;

  const tenantA = (await q("SELECT id, tenant_code, subscription_end FROM tenants"))[0];
  ok(new Date(tenantA.subscription_end) > new Date(), 'المتجر الجديد يحصل على فترة تجريبية (ليس منتهياً)');

  r = await call('POST', '/api/auth/login', { username: 'admin', password: 'bad' });
  ok(r.status === 401, 'كلمة مرور خاطئة → 401');
  r = await call('POST', '/api/auth/login', { username: 'admin', password: 'Str0ng!Pass1' });
  ok(r.status === 200 && r.body.token, 'دخول المدير');
  const A = r.body.token;
  r = await call('GET', '/api/products', null, 'garbage');
  ok(r.status === 401 && r.body.code === 'TOKEN_INVALID', 'رمز غير صالح → 401 (وليس 403)', r.body);
  r = await call('GET', '/health');
  ok(r.status === 200, 'health');
  ok(!!r.headers.get('content-security-policy'), 'ترويسة CSP موجودة');

  // ============ ثغرات الترخيص القديمة ============
  console.log('\n● الترخيص');
  for (const c of ['YEAR-ANYTHING-123456789', 'LIFETIME-AAAA-BBBB-CCCC', 'MNR-YEAR-AAAA-BBBB-CCCC-DDDD']) {
    r = await call('POST', '/api/subscription/activate', { code: c });
    ok(r.status === 400, `كود مخمَّن مرفوض: ${c}`, r.body);
  }
  r = await call('POST', '/api/subscriptions/activate-code', { code: 'anything' }, A);
  ok(r.status === 400, 'activate-code لا يقبل أي نص');
  r = await call('POST', '/api/subscriptions/renew', { months: 12 }, A);
  ok(r.status === 404, 'مسار renew المجاني محذوف');

  // المالك + توليد أكواد
  const bcrypt = require('bcryptjs');
  await q("INSERT INTO users (tenant_id, username, password_hash, full_name, role) VALUES (NULL,'owner',$1,'المالك','owner')", [await bcrypt.hash('Own3r!Passw0rd', 10)]);
  r = await call('POST', '/api/auth/login', { username: 'owner', password: 'Own3r!Passw0rd' });
  ok(r.status === 200, 'دخول المالك');
  const O = r.body.token;
  r = await call('POST', '/api/admin/license-codes', { plan: 'MONTH', count: 2 }, A);
  ok(r.status === 403, 'مدير المتجر لا يولّد أكواداً');
  r = await call('POST', '/api/admin/license-codes', { plan: 'MONTH', count: 2 }, O);
  ok(r.status === 200 && r.body.data.codes.length === 2, 'المالك يولّد أكواداً', r.body);
  const [code1] = r.body.data.codes;
  const hashRow = await q('SELECT code_hash FROM license_codes LIMIT 1');
  ok(hashRow[0].code_hash.length === 64 && !r.body.data.codes.some(c => c.includes(hashRow[0].code_hash)), 'الكود يُخزَّن مجزّأً');
  const endBefore = new Date((await q('SELECT subscription_end FROM tenants'))[0].subscription_end);
  r = await call('POST', '/api/subscription/activate', { code: code1 });
  ok(r.status === 200 && r.body.success, 'تفعيل كود صحيح (عام)', r.body);
  const endAfter = new Date((await q('SELECT subscription_end FROM tenants'))[0].subscription_end);
  ok(endAfter - endBefore > 29 * 864e5, 'مُدّد الاشتراك 30 يوماً');
  r = await call('POST', '/api/subscription/activate', { code: code1 });
  ok(r.status === 400, 'الكود لا يُستخدم مرتين');
  r = await call('GET', '/api/subscription/status');
  ok(r.body.active === true && !!r.body.endDate, 'حالة الاشتراك العامة');

  // ============ المستخدمون والصلاحيات ============
  console.log('\n● المستخدمون');
  r = await call('POST', '/api/users', { username: 'x1', password: 'Str0ng!Pass1', full_name: 'س', role: 'owner' }, A);
  ok(r.status === 400, 'مدير المتجر لا يستطيع إنشاء owner', r.body);
  const mainBranch = (await q('SELECT id FROM branches LIMIT 1'))[0].id;
  r = await call('POST', '/api/users', { username: 'cash1', password: 'Cash!Pass123', full_name: 'كاشير', role: 'cashier', branch_id: mainBranch }, A);
  ok(r.status === 200, 'إنشاء كاشير', r.body);
  const cashierId = r.body.data.id;
  r = await call('PUT', '/api/users/' + cashierId, { role: 'owner' }, A);
  ok(r.status === 400, 'لا يمكن ترقية مستخدم إلى owner', r.body);
  r = await call('POST', '/api/auth/login', { username: 'cash1', password: 'Cash!Pass123' });
  const C = r.body.token;
  r = await call('POST', '/api/users', { username: 'x2', password: 'Str0ng!Pass1', full_name: 'س', role: 'cashier', branch_id: mainBranch }, C);
  ok(r.status === 403, 'الكاشير لا ينشئ مستخدمين');
  r = await call('POST', '/api/subscriptions/activate-code', { code: 'MNR-YEAR-AAAA-BBBB-CCCC-DDDD' }, C);
  ok(r.status === 403, 'الكاشير لا يفعّل الاشتراكات');
  r = await call('POST', '/api/auth/change-password', { current_password: 'Cash!Pass123', new_password: 'N3w!Pass4567' }, C);
  ok(r.status === 200 && r.body.token, 'تغيير كلمة المرور');
  r = await call('GET', '/api/products', null, C);
  ok(r.status === 401 && r.body.code === 'TOKEN_REVOKED', 'الرمز القديم يُبطَل بعد تغيير كلمة المرور', r.body);
  r = await call('POST', '/api/auth/login', { username: 'cash1', password: 'N3w!Pass4567' });
  const C2 = r.body.token;

  // ============ المنتجات والمبيعات ============
  console.log('\n● المبيعات');
  r = await call('POST', '/api/products', { name: 'منتج 1', barcode: 'B1', sell_price: 10, cost_price: 6, stock: 5, expiry_date: '2030-01-01' }, A);
  ok(r.status === 200, 'إنشاء منتج مع تاريخ صلاحية', r.body);
  const P1 = r.body.data.id;
  r = await call('POST', '/api/products', { name: 'منتج 2', sell_price: 'abc' }, A);
  ok(r.status === 400, 'سعر غير رقمي مرفوض');
  r = await call('POST', '/api/products', { name: 'منتج 3', barcode: 'B3', sell_price: 100, cost_price: 50, stock: 50 }, A);
  const P3 = r.body.data.id;

  // سباق: 12 عملية بيع متزامنة لمخزون 5
  const results = await Promise.all(Array.from({ length: 12 }, () =>
    call('POST', '/api/sales', { items: [{ product_id: P1, qty: 1 }], payment_type: 'cash', paid: 10 }, C2)));
  const okCount = results.filter(x => x.status === 200).length;
  const stock = parseFloat((await q('SELECT stock FROM products WHERE id=$1', [P1]))[0].stock);
  ok(okCount === 5 && stock === 0, 'لا بيع زائد عن المخزون تحت التزامن', { okCount, stock });
  const nums = (await q('SELECT invoice_number FROM invoices')).map(x => x.invoice_number);
  ok(new Set(nums).size === nums.length, 'أرقام الفواتير فريدة تحت التزامن');
  const cashBal = parseFloat((await q('SELECT cash_balance FROM branches WHERE id=$1', [mainBranch]))[0].cash_balance);
  ok(near(cashBal, 50), 'رصيد الخزينة صحيح بعد 5 مبيعات', cashBal);

  // سعر أقل من الحد للكاشير
  r = await call('POST', '/api/sales', { items: [{ product_id: P3, qty: 1, unit_price: 1 }], payment_type: 'cash' }, C2);
  ok(r.status === 403 && r.body.code === 'PRICE_BELOW_MIN', 'الكاشير لا يبيع بسعر شبه مجاني', r.body);
  r = await call('POST', '/api/sales', { items: [{ product_id: P3, qty: 1 }], discount: 60, payment_type: 'cash' }, C2);
  ok(r.status === 403 && r.body.code === 'DISCOUNT_ABOVE_MAX', 'الكاشير لا يتجاوز حد الخصم', r.body);
  r = await call('POST', '/api/sales', { items: [{ product_id: P3, qty: -2 }] }, C2);
  ok(r.status === 400, 'كمية سالبة مرفوضة');

  // دفع زائد (باقي للزبون)
  const before = cashBal;
  r = await call('POST', '/api/sales', { items: [{ product_id: P3, qty: 1 }], payment_type: 'cash', paid: 150, local_id: 'L-1' }, C2);
  ok(r.status === 200 && near(r.body.data.total, 100) && near(r.body.data.change_amount, 50) && near(r.body.data.remaining, 0), 'دفع زائد: الباقي 50 والمتبقي 0', r.body.data);
  const invOver = r.body.data;
  const c2 = parseFloat((await q('SELECT cash_balance FROM branches WHERE id=$1', [mainBranch]))[0].cash_balance);
  ok(near(c2 - before, 100), 'الخزينة تزيد بقيمة الفاتورة فقط (لا بالمبلغ المدفوع)', c2 - before);
  r = await call('POST', '/api/sales', { items: [{ product_id: P3, qty: 1 }], payment_type: 'cash', paid: 150, local_id: 'L-1' }, C2);
  ok(r.status === 200 && r.body.duplicate && r.body.data.id === invOver.id, 'إعادة إرسال نفس local_id لا تكرّر الفاتورة', r.body);
  ok((await q("SELECT COUNT(*)::int n FROM invoices WHERE local_id='L-1'"))[0].n === 1, 'فاتورة واحدة فقط لـ local_id');

  // دفع مقسّم بقيم نصية
  r = await call('POST', '/api/sales', { items: [{ product_id: P3, qty: 1 }], payment_type: 'split', paid: 100, payment_details: { cash: '40', card: '60' } }, C2);
  ok(r.status === 200, 'دفع مقسّم', r.body);
  const c3 = parseFloat((await q('SELECT cash_balance FROM branches WHERE id=$1', [mainBranch]))[0].cash_balance);
  ok(near(c3 - c2, 40), 'الدفع المقسّم: النقد 40 فقط في الخزينة (لا تجميع نصوص)', c3 - c2);
  const splitInv = r.body.data;

  // الإلغاء يعكس الخزينة والمخزون
  const stockP3Before = parseFloat((await q('SELECT stock FROM products WHERE id=$1', [P3]))[0].stock);
  r = await call('POST', `/api/sales/${splitInv.id}/cancel`, { reason: 'اختبار' }, C2);
  ok(r.status === 403, 'الكاشير لا يلغي فواتير');
  r = await call('POST', `/api/sales/${splitInv.id}/cancel`, { reason: 'اختبار' }, A);
  ok(r.status === 200, 'المدير يلغي الفاتورة', r.body);
  const c4 = parseFloat((await q('SELECT cash_balance FROM branches WHERE id=$1', [mainBranch]))[0].cash_balance);
  ok(near(c4, c3 - 40), 'الإلغاء يعكس الخزينة', { c3, c4 });
  const stockP3After = parseFloat((await q('SELECT stock FROM products WHERE id=$1', [P3]))[0].stock);
  ok(stockP3After === stockP3Before + 1, 'الإلغاء يعيد المخزون');
  r = await call('POST', `/api/sales/${splitInv.id}/cancel`, {}, A);
  ok(r.status === 400, 'لا إلغاء مزدوج');

  // ============ العملاء: دين + تحصيل + ولاء + كشف حساب ============
  console.log('\n● العملاء والدين والولاء');
  r = await call('POST', '/api/customers', { name: 'عميل 1', phone: '0912345678', credit_limit: 300 }, A);
  const cust = r.body.data.id;
  r = await call('POST', '/api/sales', { items: [{ product_id: P3, qty: 1 }], payment_type: 'credit', paid: 20 }, C2);
  ok(r.status === 400, 'بيع آجل بدون عميل مرفوض');
  r = await call('POST', '/api/sales', { items: [{ product_id: P3, qty: 4 }], payment_type: 'credit', paid: 0, customer_id: cust }, C2);
  ok(r.status === 400 && r.body.code === 'CREDIT_LIMIT', 'سقف الدين مُطبَّق', r.body);
  r = await call('PUT', '/api/settings', { loyalty_enabled: true, loyalty_spend_per_point: 10, loyalty_redeem_value: 0.5 }, A);
  ok(r.status === 200, 'تفعيل الولاء', r.body);
  r = await call('PUT', '/api/settings', { evil_key: 1 }, A);
  ok(r.status === 400, 'إعداد غير معروف مرفوض');
  r = await call('PUT', '/api/settings', { loyalty_enabled: false }, C2);
  ok(r.status === 403, 'الكاشير لا يعدّل الإعدادات');
  // ----- هوية المتجر -----
  const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
  r = await call('PUT', '/api/settings', { brand_color: '#aa3300', brand_logo: PNG, receipt_header: 'الرقم الضريبي 123' }, A);
  ok(r.status === 200, 'حفظ هوية المتجر', r.body);
  r = await call('GET', '/api/settings/brand', null, C2);
  ok(r.status === 200 && r.body.data.color === '#aa3300' && r.body.data.logo === PNG && r.body.data.header === 'الرقم الضريبي 123', 'الكاشير يقرأ هوية المتجر', r.body);
  r = await call('PUT', '/api/settings', { brand_color: 'red' }, A);
  ok(r.status === 400, 'لون غير صالح مرفوض');
  r = await call('PUT', '/api/settings', { brand_logo: 'data:image/svg+xml;base64,PHN2Zz4=' }, A);
  ok(r.status === 400, 'شعار SVG مرفوض');
  r = await call('PUT', '/api/settings', { brand_logo: 'javascript:alert(1)' }, A);
  ok(r.status === 400, 'شعار برابط خطير مرفوض');
  r = await call('PUT', '/api/settings', { brand_logo: 'data:image/png;base64,' + 'A'.repeat(160000) }, A);
  ok(r.status === 400, 'شعار كبير مرفوض');
  r = await call('PUT', '/api/settings', { brand_color: '#112233' }, C2);
  ok(r.status === 403, 'الكاشير لا يعدّل الهوية');
  r = await call('POST', '/api/sales', { items: [{ product_id: P3, qty: 2 }], payment_type: 'credit', paid: 50, customer_id: cust }, C2);
  ok(r.status === 200 && near(r.body.data.remaining, 150) && r.body.data.points_earned === 5, 'بيع آجل: متبقٍ 150 ونقاط 5', r.body.data);
  const credInv = r.body.data;
  let cu = (await q('SELECT balance, points FROM customers WHERE id=$1', [cust]))[0];
  ok(near(cu.balance, 150) && cu.points === 5, 'رصيد العميل 150 ونقاطه 5', cu);
  r = await call('POST', `/api/customers/${cust}/payments`, { amount: 500 }, C2);
  ok(r.status === 400 && r.body.code === 'OVERPAY', 'تحصيل أكبر من الدين مرفوض', r.body);
  const cb = parseFloat((await q('SELECT cash_balance FROM branches WHERE id=$1', [mainBranch]))[0].cash_balance);
  r = await call('POST', `/api/customers/${cust}/payments`, { amount: 100, method: 'cash' }, C2);
  ok(r.status === 200 && near(r.body.data.balance_after, 50), 'تحصيل 100 من الدين', r.body);
  const cb2 = parseFloat((await q('SELECT cash_balance FROM branches WHERE id=$1', [mainBranch]))[0].cash_balance);
  ok(near(cb2 - cb, 100), 'التحصيل النقدي يدخل الخزينة');
  r = await call('GET', `/api/customers/${cust}/statement`, null, C2);
  ok(r.status === 200 && near(r.body.data.computed_balance, 50) && near(r.body.data.customer.balance, 50), 'كشف الحساب يطابق الرصيد', r.body.data && r.body.data.computed_balance);
  r = await call('POST', '/api/sales', { items: [{ product_id: P3, qty: 1 }], payment_type: 'cash', customer_id: cust, redeem_points: 5 }, C2);
  ok(r.status === 200 && near(r.body.data.total, 97.5) && r.body.data.points_redeemed === 5, 'استبدال 5 نقاط = خصم 2.5', r.body.data);
  r = await call('GET', `/api/sales/${credInv.id}/share`, null, C2);
  ok(r.status === 200 && r.body.data.whatsapp_url.startsWith('https://wa.me/218912345678?text='), 'رابط واتساب بصيغة ليبية دولية', r.body.data && r.body.data.whatsapp_url);

  // ============ المرتجعات ============
  console.log('\n● المرتجعات');
  r = await call('POST', '/api/returns', { items: [{ product_id: P3, qty: 1, unit_price: 100 }] }, C2);
  ok(r.status === 403, 'الكاشير لا يرجع بدون فاتورة');
  r = await call('POST', '/api/returns', { invoice_id: invOver.id, items: [{ product_id: P3, qty: 5 }] }, C2);
  ok(r.status === 400 && r.body.code === 'RETURN_EXCEEDS_SOLD', 'لا إرجاع أكثر من المباع', r.body);
  const cb3 = parseFloat((await q('SELECT cash_balance FROM branches WHERE id=$1', [mainBranch]))[0].cash_balance);
  r = await call('POST', '/api/returns', { invoice_id: invOver.id, items: [{ product_id: P3, qty: 1, unit_price: 99999 }], refund_method: 'cash' }, C2);
  ok(r.status === 200 && near(r.body.data.total_refund, 100), 'السعر من الفاتورة لا من العميل', r.body.data);
  const cb4 = parseFloat((await q('SELECT cash_balance FROM branches WHERE id=$1', [mainBranch]))[0].cash_balance);
  ok(near(cb3 - cb4, 100), 'المرتجع النقدي يخصم من الخزينة');
  r = await call('POST', '/api/returns', { invoice_id: invOver.id, items: [{ product_id: P3, qty: 1 }] }, C2);
  ok(r.status === 400, 'لا إرجاع ثانٍ لنفس البند');
  r = await call('POST', `/api/sales/${invOver.id}/cancel`, {}, A);
  ok(r.status === 400, 'لا إلغاء لفاتورة لها مرتجعات');

  // ============ الخزينة: المصروفات + الموردين + الوردية ============
  console.log('\n● الخزينة والورديات');
  r = await call('POST', '/api/shifts/open', { opening_cash: 200 }, C2);
  ok(r.status === 200, 'فتح وردية');
  r = await call('POST', '/api/shifts/open', { opening_cash: 0 }, C2);
  ok(r.status === 400 && r.body.code === 'SHIFT_ALREADY_OPEN', 'وردية واحدة مفتوحة فقط');
  r = await call('POST', '/api/sales', { items: [{ product_id: P3, qty: 1 }], payment_type: 'cash' }, C2);
  ok(r.status === 200, 'بيع داخل الوردية');
  r = await call('POST', '/api/expenses', { amount: 30, category: 'نظافة' }, C2);
  ok(r.status === 200, 'مصروف 30');
  const exp = r.body.data;
  r = await call('DELETE', '/api/expenses/' + exp.id, null, C2);
  ok(r.status === 403, 'الكاشير لا يحذف مصروفاً');
  r = await call('POST', '/api/expenses', { amount: 'abc' }, C2);
  ok(r.status === 400, 'مبلغ مصروف غير رقمي مرفوض');
  r = await call('GET', '/api/shifts/current', null, C2);
  ok(r.status === 200 && near(r.body.data.live.expected_cash, 200 + 100 - 30), 'المتوقع في الدرج = 200 + 100 − 30', r.body.data && r.body.data.live);
  r = await call('POST', '/api/shifts/close', { counted_cash: 265 }, C2);
  ok(r.status === 200 && near(r.body.data.difference, -5), 'إغلاق الوردية: العجز −5', r.body.data);
  r = await call('GET', '/api/shifts', null, A);
  ok(r.status === 200 && r.body.data.length === 1, 'سجل الورديات');

  // ============ التصدير والتنبيهات ============
  console.log('\n● التصدير والتنبيهات');
  const rawRes = await fetch(base + '/api/export/sales', { headers: { Authorization: 'Bearer ' + A } });
  const bytes = new Uint8Array(await rawRes.arrayBuffer());
  ok(rawRes.status === 200 && bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF, 'CSV مبيعات يبدأ بـ BOM (لقراءة العربية في Excel)');
  r = await call('GET', '/api/export/sales', null, A);
  ok(r.text.includes('رقم الفاتورة') && r.text.includes('INV-'), 'CSV يحتوي الأعمدة والبيانات');
  r = await call('GET', '/api/export/sales', null, C2);
  ok(r.status === 403, 'الكاشير لا يصدّر');
  await call('POST', '/api/customers', { name: '=cmd|calc', phone: '1' }, A);
  r = await call('GET', '/api/export/customers', null, A);
  ok(r.text.includes("'=cmd|calc"), 'منع حقن الصيغ في CSV');
  r = await call('GET', '/api/export/hack', null, A);
  ok(r.status === 404, 'نوع تصدير مجهول → 404');
  r = await call('GET', '/api/alerts', null, A);
  ok(r.status === 200 && r.body.data.counts.low_stock >= 1, 'تنبيه مخزون منخفض', r.body.data && r.body.data.counts);

  // ============ تعدد المتاجر وعزلها ============
  console.log('\n● عزل المتاجر');
  r = await call('POST', '/api/admin/tenants', { business_name: 'متجر ب', owner_name: 'ب', owner_phone: '0920000000', admin_username: 'admin', admin_password: 'Admin!B-Pass1' }, O);
  ok(r.status === 200, 'المالك ينشئ متجراً ثانياً', r.body);
  const tenantBCode = r.body.data.tenant_code, tenantBId = r.body.data.id;
  r = await call('POST', '/api/auth/login', { username: 'admin', password: 'Admin!B-Pass1' });
  ok(r.status === 200 && r.body.user.tenant_code === tenantBCode, 'اسم admin المكرر: كلمة المرور تحدد المتجر الصحيح');
  const B = r.body.token;
  r = await call('POST', '/api/auth/login', { username: 'admin', password: 'Admin!B-Pass1', tenant_code: tenantA.tenant_code });
  ok(r.status === 401, 'tenant_code خاطئ لا يسمح بالدخول لمتجر آخر');
  r = await call('POST', `/api/users/${cashierId}/toggle`, {}, B);
  ok(r.status === 404, 'مدير متجر ب لا يعطّل مستخدم متجر أ');
  r = await call('DELETE', `/api/users/${cashierId}`, null, B);
  ok(r.status === 404, 'ولا يحذفه');
  r = await call('GET', `/api/sales/${invOver.id}`, null, B);
  ok(r.status === 404, 'ولا يرى فواتيره');
  r = await call('GET', '/api/admin/tenants', null, A);
  ok(r.status === 403, 'مدير المتجر لا يرى قائمة العملاء');
  r = await call('GET', '/api/admin/tenants', null, O);
  ok(r.status === 200 && r.body.data.length === 2, 'المالك يرى العملاء');
  r = await call('POST', `/api/admin/tenants/${tenantBId}/suspend`, { suspend: true, reason: 'اختبار' }, O);
  r = await call('GET', '/api/products', null, B);
  ok(r.status === 403 && r.body.code === 'TENANT_SUSPENDED', 'الإيقاف يسري فوراً على الجلسات الجارية', r.body);
  r = await call('POST', `/api/admin/tenants/${tenantBId}/suspend`, { suspend: false }, O);
  r = await call('GET', '/api/products', null, B);
  ok(r.status === 200, 'رفع الإيقاف');
  await q("UPDATE tenants SET subscription_end = NOW() - INTERVAL '1 day' WHERE id=$1", [tenantBId]);
  r = await call('GET', '/api/products', null, B);
  ok(r.status === 403 && r.body.code === 'SUBSCRIPTION_EXPIRED', 'انتهاء الاشتراك يحجب API', r.body);
  r = await call('POST', `/api/admin/tenants/${tenantBId}/renew`, { months: 1 }, O);
  r = await call('GET', '/api/products', null, B);
  ok(r.status === 200, 'التجديد من المالك يعيد الوصول');

  // ============ ملفات ثابتة ============
  console.log('\n● الملفات الثابتة');
  for (const p of ['/index.html.backup-1', '/.env', '/x.sql', '/data/license.json']) {
    r = await call('GET', p);
    ok(r.status === 404 || (r.status === 200 && !r.text.includes('JWT_SECRET') && !p.includes('backup')), `لا تُخدَّم: ${p}`, r.status);
  }
  r = await call('GET', '/api/auto-tunnel-url');
  ok(r.status === 404, 'مسار الرابط العام القديم محذوف');

  // ============ الاستيراد والتصدير والنسخ الاحتياطي ============
  console.log('\n● الاستيراد والتصدير');
  await call('POST', '/api/users', { username: 'cash9', password: 'Cash!Pass999', full_name: 'كاشير٩', role: 'cashier', branch_id: mainBranch }, A);
  const cashierTok = (await call('POST', '/api/auth/login', { username: 'cash9', password: 'Cash!Pass999' })).body.token;
  r = await call('POST', '/api/data/import/products', { rows: [
    { 'الباركود': 'IMP-1', 'الاسم': 'منتج مستورد ١', 'سعر البيع': '٢٫٥', 'سعر التكلفة': '1.5', 'الكمية': '10' },
    { barcode: 'IMP-2', name: 'Imported 2', sell_price: '4', stock: '3', expiry_date: '2027-01-31' },
    { 'الاسم': 'بدون سعر' },
    { 'الاسم': 'سعر سالب', 'سعر البيع': '-5' },
    { foo: 'bar' }
  ] }, A);
  ok(r.status === 200 && r.body.data.inserted === 2 && r.body.data.errors.length === 3, 'استيراد المنتجات: 2 نجحا و3 أخطاء مفصّلة', r.body);
  ok(r.body.data.errors[0].row === 4, 'رقم الصف في الخطأ يطابق ملف CSV (الرأس = 1)', r.body.data.errors);
  const imp = (await q("SELECT sell_price, stock FROM products WHERE barcode='IMP-1'"))[0];
  ok(imp && near(imp.sell_price, 2.5) && near(imp.stock, 10), 'الأرقام العربية تُحوَّل صحيحاً (٢٫٥ → 2.5)', imp);

  r = await call('POST', '/api/data/import/products', { rows: [{ barcode: 'IMP-1', name: 'منتج مستورد ١', sell_price: '9', stock: '999' }] }, A);
  ok(r.body.data.skipped === 1 && r.body.data.inserted === 0, 'المكرر يُتخطّى افتراضياً', r.body);
  r = await call('POST', '/api/data/import/products', { on_duplicate: 'update', rows: [{ barcode: 'IMP-1', name: 'منتج مستورد ١', sell_price: '9', stock: '999' }] }, A);
  const imp2 = (await q("SELECT sell_price, stock FROM products WHERE barcode='IMP-1'"))[0];
  ok(r.body.data.updated === 1 && near(imp2.sell_price, 9) && near(imp2.stock, 10), 'التحديث يغيّر السعر ولا يمسّ الكمية', imp2);

  const prodCountBefore = (await q("SELECT COUNT(*)::int n FROM products"))[0].n;
  r = await call('POST', '/api/data/import/products', { dry_run: true, rows: [{ barcode: 'DRY-1', name: 'تجريبي', sell_price: '1' }] }, A);
  ok(r.body.data.dry_run && r.body.data.inserted === 1 && (await q('SELECT COUNT(*)::int n FROM products'))[0].n === prodCountBefore, 'المعاينة (dry_run) لا تكتب شيئاً');

  r = await call('POST', '/api/data/import/customers', { rows: [{ 'الاسم': 'عميل مستورد', 'الهاتف': '0911112222', 'الرصيد (دين)': '50' }] }, A);
  ok(r.body.data.inserted === 1, 'استيراد العملاء');
  r = await call('POST', '/api/data/import/suppliers', { rows: [{ name: 'مورد مستورد', phone: '0922223333' }] }, A);
  ok(r.body.data.inserted === 1, 'استيراد الموردين');
  r = await call('POST', '/api/data/import/products', { rows: Array(5001).fill({ name: 'x', sell_price: 1 }) }, A);
  ok(r.status === 400, 'أكثر من 5000 صف مرفوض');
  r = await call('POST', '/api/data/import/products', { rows: [{ name: 'x', sell_price: 1 }] }, cashierTok);
  ok(r.status === 403, 'الكاشير لا يستطيع الاستيراد', r.status);
  r = await call('POST', '/api/data/import/orders', { rows: [{}] }, A);
  ok(r.status === 404, 'نوع استيراد غير معروف → 404');

  // دورة كاملة: تصدير CSV ثم إعادة استيراده
  r = await call('GET', '/api/export/products', null, A);
  ok(r.status === 200 && r.text.includes('IMP-2'), 'تصدير المنتجات يتضمن المستوردة');
  r = await call('GET', '/api/data/template/products', null, A);
  ok(r.status === 200 && r.headers.get('content-type').includes('text/csv') && r.text.includes('الباركود'), 'قالب CSV متاح');

  r = await call('GET', '/api/data/backup', null, A);
  let bk; try { bk = JSON.parse(r.text); } catch { bk = null; }
  ok(r.status === 200 && bk && Array.isArray(bk.products) && bk.products.length >= 2 && Array.isArray(bk.invoices), 'نسخة JSON كاملة تُنزَّل', r.status);
  ok(bk && !/password|token_version/i.test(r.text), 'النسخة الاحتياطية لا تحوي كلمات مرور');
  ok(bk && bk.products.every(p => p.tenant_id === tenantA.id), 'النسخة لمتجر واحد فقط (لا تسرّب بيانات متاجر أخرى)');
  r = await call('GET', '/api/data/backup', null, cashierTok);
  ok(r.status === 403, 'الكاشير لا يستطيع تنزيل النسخة الكاملة', r.status);

  // ============ الباركود + ضبط المخزون ============
  console.log('\n● الباركود والمخزون');
  const { internalEAN13, isValidEAN13, ean13Check } = require('../server/lib/barcode');
  const mk = async (b) => (await call('POST', '/api/products', { stock: 0, cost_price: 1, ...b }, A));
  let r1 = await mk({ name: 'حليب BC', barcode: '6221234567890', sell_price: 2, stock: 100 });
  ok(r1.status === 200, 'إنشاء منتج بباركود');
  const prodBC = r1.body.data;
  r = await mk({ name: 'منتج آخر', barcode: '6221234567890', sell_price: 3 });
  ok(r.status === 409 && r.body.error.includes('حليب BC'), 'منع تكرار الباركود الرئيسي مع اسم المنتج المتعارض', r.status);
  r = await call('PUT', '/api/products/' + prodBC.id, { barcode: '6221234567890' }, A);
  ok(r.status === 200, 'تعديل المنتج بباركوده نفسه مسموح');
  r = await mk({ name: 'باركود بمسافة', barcode: '12 34', sell_price: 1 });
  ok(r.status === 400, 'باركود به مسافة مرفوض');

  // باركود كرتونة
  r = await call('POST', `/api/inventory/products/${prodBC.id}/barcodes`, { barcode: 'CTN-001', pack_qty: 12, label: 'كرتونة' }, A);
  ok(r.status === 200, 'إضافة باركود كرتونة');
  r = await call('POST', `/api/inventory/products/${prodBC.id}/barcodes`, { barcode: 'CTN-001', pack_qty: 6 }, A);
  ok(r.status === 409, 'منع تكرار الباركود الإضافي');
  r = await mk({ name: 'منتج ثالث', barcode: 'CTN-001', sell_price: 3 });
  ok(r.status === 409, 'باركود إضافي لا يُستخدم كباركود رئيسي لمنتج آخر');
  r = await call('GET', '/api/products/barcode/CTN-001', null, A);
  ok(r.status === 200 && r.body.data.id === prodBC.id && r.body.scan.qty === 12 && r.body.scan.kind === 'pack', 'مسح الكرتونة يعيد المنتج وكمية 12', r.body.scan);
  r = await call('GET', '/api/products/barcode/6221234567890', null, A);
  ok(r.body.scan.qty === 1 && r.body.scan.kind === 'main', 'مسح الباركود الرئيسي كمية 1');
  r = await call('GET', '/api/products?search=CTN-001', null, A);
  ok(r.body.data.length === 1 && r.body.data[0].extra_barcodes.length === 1, 'البحث يجد المنتج بالباركود الإضافي وتظهر قائمة الإضافية');

  // باركود الميزان: 2 + PLU(6) + غرامات(5) + تحقق
  const mkScale = (plu, grams) => { const d = '2' + String(plu).padStart(6, '0') + String(grams).padStart(5, '0'); return d + ean13Check(d); };
  r = await mk({ name: 'جبنة وزن', sell_price: 20, stock: 50, unit: 'كغ', sold_by_weight: true });
  ok(r.status === 400, 'منتج بالوزن بدون PLU مرفوض');
  r = await mk({ name: 'جبنة وزن', sell_price: 20, stock: 50, unit: 'كغ', sold_by_weight: true, plu: '123' });
  ok(r.status === 200 && r.body.data.plu === '000123', 'PLU يُخزَّن بـ6 خانات');
  const cheese = r.body.data;
  const sc = mkScale(123, 1250);
  ok(isValidEAN13(sc), 'باركود الميزان المُولَّد صالح EAN-13: ' + sc);
  r = await call('GET', '/api/products/barcode/' + sc, null, A);
  ok(r.status === 200 && r.body.data.id === cheese.id && near(r.body.scan.qty, 1.25) && r.body.scan.kind === 'scale', 'مسح ملصق الميزان = 1.25 كغ', r.body.scan);
  r = await call('GET', '/api/products/barcode/' + sc.slice(0, 12) + ((+sc[12] + 1) % 10), null, A);
  ok(r.status === 404, 'ملصق ميزان بخانة تحقق خاطئة مرفوض');
  r = await mk({ name: 'جبنة ثانية', sell_price: 1, sold_by_weight: true, plu: '123' });
  ok(r.status >= 400, 'PLU مكرر في نفس الفرع مرفوض', r.status);

  // توليد باركود داخلي
  const noBc = (await mk({ name: 'بدون باركود 1', sell_price: 1 })).body.data;
  const noBc2 = (await mk({ name: 'بدون باركود 2', sell_price: 1 })).body.data;
  r = await call('POST', '/api/inventory/barcodes/generate', { product_ids: [noBc.id, noBc2.id, cheese.id] }, A);
  ok(r.status === 200 && r.body.data.count === 2, 'توليد باركود لمنتجين فقط (الوزن مستثنى)', r.body);
  const gen = (await q('SELECT barcode FROM products WHERE id = ANY($1::uuid[]) ORDER BY name', [[noBc.id, noBc2.id]])).map(x => x.barcode);
  ok(gen.every(isValidEAN13) && gen[0].startsWith('29') && gen[0] !== gen[1], 'الباركودان صالحان EAN-13 ومختلفان ويبدآن بـ29', gen);
  r = await call('POST', '/api/inventory/barcodes/generate', { product_ids: [noBc.id] }, A);
  ok(r.body.data.count === 0, 'لا يُعاد توليد باركود لمنتج لديه باركود');
  ok(internalEAN13(1).length === 13 && isValidEAN13(internalEAN13(987654)), 'دالة EAN الداخلية سليمة');

  // ----- تسويات -----
  r = await call('POST', '/api/inventory/adjust', { product_id: prodBC.id, delta: -5 }, A);
  ok(r.status === 400, 'التسوية بلا سبب مرفوضة');
  r = await call('POST', '/api/inventory/adjust', { product_id: prodBC.id, delta: -5, reason_code: 'damage', notes: 'سقط' }, A);
  ok(r.status === 200 && near(r.body.data.stock_after, 95), 'تسوية تالف −5');
  r = await call('POST', '/api/inventory/adjust', { product_id: prodBC.id, delta: -500, reason_code: 'theft' }, A);
  ok(r.status === 400, 'لا يُسمح بمخزون سالب');
  r = await call('POST', '/api/inventory/adjust', { product_id: prodBC.id, delta: 1, new_stock: 3, reason_code: 'found' }, A);
  ok(r.status === 400, 'delta و new_stock معاً مرفوض');
  r = await call('GET', '/api/inventory/movements?product_id=' + prodBC.id + '&type=damage', null, A);
  ok(r.body.data.length === 1 && near(r.body.data[0].quantity, -5) && r.body.data[0].notes.includes('تالف'), 'سجل الحركة يعرض التسوية بسببها');
  r = await call('POST', '/api/inventory/adjust', { product_id: prodBC.id, delta: 1, reason_code: 'found' }, cashierTok);
  ok(r.status === 403, 'الكاشير لا يملك التسوية');

  // ----- جرد -----
  r = await call('POST', '/api/inventory/stocktakes', { name: 'جرد أسبوعي' }, A);
  ok(r.status === 200 && /^STK-/.test(r.body.data.number), 'فتح جلسة جرد');
  const stk = r.body.data;
  await call('POST', '/api/inventory/adjust', { product_id: prodBC.id, new_stock: 90, reason_code: 'correction' }, A);
  r = await call('POST', `/api/inventory/stocktakes/${stk.id}/count`, { code: '6221234567890' }, A);
  ok(r.status === 200 && near(r.body.data.counted, 1) && near(r.body.data.expected, 90), 'المسح الأول يسجل 1');
  await call('POST', `/api/inventory/stocktakes/${stk.id}/count`, { code: '6221234567890' }, A);
  r = await call('POST', `/api/inventory/stocktakes/${stk.id}/count`, { code: 'CTN-001' }, A);
  ok(near(r.body.data.counted, 14), 'مسحتان + كرتونة (12) = 14');
  r = await call('POST', `/api/inventory/stocktakes/${stk.id}/count`, { product_id: prodBC.id, counted: 88 }, A);
  ok(near(r.body.data.counted, 88), 'إدخال يدوي للكمية الفعلية 88');
  r = await call('POST', `/api/inventory/stocktakes/${stk.id}/count`, { code: 'NOPE-999' }, A);
  ok(r.status === 404, 'باركود مجهول في الجرد 404');
  r = await call('GET', `/api/inventory/stocktakes/${stk.id}`, null, A);
  ok(r.body.data.items.length === 1 && near(r.body.data.items[0].variance, -2) && near(r.body.data.summary.shortage_value, 2), 'تقرير الجرد: عجز 2 بقيمة 2', r.body.data.summary);
  // بيع أثناء الجرد لا يضيع: delta تُطبَّق على المخزون الحالي
  await call('POST', '/api/sales', { items: [{ product_id: prodBC.id, qty: 3 }], payment_type: 'cash', paid: 100, local_id: 'stk-sale-1' }, A);
  r = await call('POST', `/api/inventory/stocktakes/${stk.id}/close`, {}, cashierTok);
  ok(r.status === 403, 'الكاشير لا يغلق الجرد');
  r = await call('POST', `/api/inventory/stocktakes/${stk.id}/close`, {}, A);
  ok(r.status === 200 && r.body.data.adjusted === 1, 'إغلاق الجرد وتطبيق الفروقات', r.body);
  const afterStk = (await q('SELECT stock FROM products WHERE id=$1', [prodBC.id]))[0].stock;
  ok(near(afterStk, 90 - 3 - 2), 'المخزون = 90 − 3 (بيع أثناء الجرد) − 2 (عجز) = 85', afterStk);
  r = await call('POST', `/api/inventory/stocktakes/${stk.id}/close`, {}, A);
  ok(r.status === 400, 'لا يُغلق الجرد مرتين');
  r = await call('POST', `/api/inventory/stocktakes/${stk.id}/count`, { code: '6221234567890' }, A);
  ok(r.status === 400, 'لا عدّ في جرد مغلق');

  // ----- تحويل بين الفروع -----
  r = await call('POST', '/api/branches', { name: 'فرع ٢', branch_code: 'BR777' }, A);
  ok(r.status === 200, 'إنشاء فرع ثانٍ', r.body);
  const br2 = r.body.data.id;
  r = await call('POST', '/api/inventory/transfers', { to_branch_id: br2, items: [{ product_id: prodBC.id, quantity: 200 }] }, A);
  ok(r.status === 400, 'تحويل أكثر من المتوفر مرفوض');
  r = await call('POST', '/api/inventory/transfers', { to_branch_id: mainBranch, items: [{ product_id: prodBC.id, quantity: 1 }] }, A);
  ok(r.status === 400, 'التحويل لنفس الفرع مرفوض');
  r = await call('POST', '/api/inventory/transfers', { to_branch_id: br2, items: [{ product_id: prodBC.id, quantity: 10 }, { product_id: cheese.id, quantity: 5.5 }], notes: 'تموين' }, A);
  ok(r.status === 200 && /^TRF-/.test(r.body.data.number), 'تحويل صنفين إلى الفرع الثاني', r.body);
  const src = (await q('SELECT stock FROM products WHERE id=$1', [prodBC.id]))[0].stock;
  const dstRows = await q('SELECT stock, barcode FROM products WHERE branch_id=$1 AND LOWER(name)=LOWER($2)', [br2, 'حليب BC']);
  ok(near(src, 75) && dstRows.length === 1 && near(dstRows[0].stock, 10) && dstRows[0].barcode === '6221234567890', 'خُصم من المصدر وأُنشئ المنتج في الفرع المستلم بالباركود نفسه', { src, dstRows });
  const cheeseDst = await q('SELECT stock, plu, sold_by_weight FROM products WHERE branch_id=$1 AND name=$2', [br2, 'جبنة وزن']);
  ok(near(cheeseDst[0].stock, 5.5) && cheeseDst[0].plu === '000123' && cheeseDst[0].sold_by_weight, 'كمية عشرية وPLU ينتقلان');
  // تحويل ثانٍ يضيف للمنتج الموجود بدل إنشاء نسخة
  await call('POST', '/api/inventory/transfers', { to_branch_id: br2, items: [{ product_id: prodBC.id, quantity: 5 }] }, A);
  const dst2 = await q('SELECT stock FROM products WHERE branch_id=$1 AND LOWER(name)=LOWER($2)', [br2, 'حليب BC']);
  ok(dst2.length === 1 && near(dst2[0].stock, 15), 'التحويل الثاني يضيف للمنتج نفسه (بلا تكرار)');
  const mv = await q("SELECT movement_type FROM stock_movements WHERE reference_type='transfer' AND product_id=$1", [prodBC.id]);
  ok(mv.length === 2 && mv.every(m => m.movement_type === 'transfer_out'), 'حركات التحويل مسجلة');
  r = await call('GET', '/api/inventory/transfers', null, A);
  ok(r.body.data.length === 2 && r.body.data[0].from_branch && r.body.data[0].to_branch, 'قائمة التحويلات');
  // تحويلان متزامنان لا يجعلان المخزون سالباً
  const stockNow = parseFloat((await q('SELECT stock FROM products WHERE id=$1', [prodBC.id]))[0].stock);
  const race = await Promise.all([1, 2, 3].map(() => call('POST', '/api/inventory/transfers', { to_branch_id: br2, items: [{ product_id: prodBC.id, quantity: Math.floor(stockNow / 2) + 1 }] }, A)));
  const raceOk = race.filter(x => x.status === 200).length;
  ok(raceOk === 1 && parseFloat((await q('SELECT stock FROM products WHERE id=$1', [prodBC.id]))[0].stock) >= 0, 'تحويلات متزامنة: ينجح واحد فقط ولا مخزون سالب', race.map(x => x.status));

  // ----- إعادة الطلب -----
  await call('POST', '/api/sales', { items: [{ product_id: cheese.id, qty: 40 }], payment_type: 'cash', paid: 5000, local_id: 'reorder-1' }, A);
  r = await call('GET', '/api/inventory/reorder?days=30&cover=14', null, A);
  const ro = r.body.data.find(x => x.product_id === cheese.id);
  ok(r.status === 200 && ro && ro.suggested_qty > 0 && ro.avg_daily > 1, 'اقتراح إعادة طلب للجبنة بناءً على معدل البيع', ro);
  ok(r.body.data.every(x => x.suggested_qty > 0) && r.body.total_est_cost >= 0, 'كل الاقتراحات كمياتها موجبة');

  // ----- العروض واعتماد المدير -----
  const promoProd = (await call('POST', '/api/products', { name: 'عصير عرض', barcode: '6229990001112', sell_price: 10, cost_price: 6, stock: 100, min_price: 9, category: 'مشروبات' }, A)).body.data;
  r = await call('POST', '/api/promotions', { name: 'خصم 20%', kind: 'percent', value: 20, product_id: promoProd.id }, cashierTok);
  ok(r.status === 403, 'الكاشير لا ينشئ عروضاً');
  r = await call('POST', '/api/promotions', { name: 'خطأ', kind: 'percent', value: 150, product_id: promoProd.id }, A);
  ok(r.status === 400, 'نسبة عرض أكبر من 100 مرفوضة');
  r = await call('POST', '/api/promotions', { name: 'بلا هدف', kind: 'percent', value: 10 }, A);
  ok(r.status === 400, 'عرض بلا منتج/تصنيف مرفوض');
  r = await call('POST', '/api/promotions', { name: 'خصم 20%', kind: 'percent', value: 20, product_id: promoProd.id }, A);
  ok(r.status === 200, 'إنشاء عرض نسبة', r.body);
  const promo1 = r.body.data;
  r = await call('GET', '/api/products', null, cashierTok);
  const pp = (r.body.data || r.body.products || []).find(x => x.id === promoProd.id);
  ok(pp && near(pp.promo_price, 8) && pp.promo_name === 'خصم 20%', 'قائمة المنتجات تُرجع سعر العرض', pp);
  r = await call('POST', '/api/sales', { items: [{ product_id: promoProd.id, qty: 2 }], payment_type: 'cash', paid: 100, local_id: 'promo-s1' }, cashierTok);
  ok(r.status === 200 && near(r.body.data.total, 16), 'البيع بسعر العرض تلقائياً (2×8)', r.body);
  // تحت الحد الأدنى للسعر (9) رغم أن العرض 8 → يحتاج اعتماد
  r = await call('POST', '/api/sales', { items: [{ product_id: promoProd.id, qty: 1, unit_price: 5 }], payment_type: 'cash', paid: 100, local_id: 'promo-s2' }, cashierTok);
  ok(r.status >= 400 && r.body.code === 'PRICE_BELOW_MIN', 'سعر تحت الحد الأدنى يُرفض للكاشير', r.body);
  // اعتماد خاطئ
  r = await call('POST', '/api/sales', { items: [{ product_id: promoProd.id, qty: 1, unit_price: 5 }], payment_type: 'cash', paid: 100, local_id: 'promo-s3', approver: { username: 'cash9', password: 'Cash!Pass999' } }, cashierTok);
  ok(r.status === 403 && r.body.code === 'APPROVAL_DENIED', 'اعتماد من كاشير مرفوض', r.body);
  r = await call('POST', '/api/sales', { items: [{ product_id: promoProd.id, qty: 1, unit_price: 5 }], payment_type: 'cash', paid: 100, local_id: 'promo-s4', approver: { username: 'admin', password: 'wrong' } }, cashierTok);
  ok(r.status === 403, 'كلمة مرور مدير خاطئة مرفوضة');
  const noInv = await q("SELECT 1 FROM invoices WHERE local_id IN ('promo-s2','promo-s3','promo-s4')");
  ok(noInv.length === 0, 'لا فواتير من المحاولات المرفوضة');
  // اعتماد صحيح
  const adminUser = (await q("SELECT username FROM users WHERE tenant_id=$1 AND role IN ('owner','tenant_admin') ORDER BY created_at LIMIT 1", [tenantA.id]))[0].username;
  r = await call('POST', '/api/sales', { items: [{ product_id: promoProd.id, qty: 1, unit_price: 5 }], payment_type: 'cash', paid: 100, local_id: 'promo-s5', approver: { username: adminUser, password: 'Str0ng!Pass1' } }, cashierTok);
  ok(r.status === 200 && near(r.body.data.total, 5), 'اعتماد المدير يسمح بالسعر الأدنى', r.body);
  const ap = await q("SELECT approved_by FROM invoices WHERE local_id='promo-s5'");
  ok(ap.length === 1 && ap[0].approved_by, 'الفاتورة تحفظ من اعتمدها');
  // إعادة إرسال نفس local_id لا تكرر
  r = await call('POST', '/api/sales', { items: [{ product_id: promoProd.id, qty: 1, unit_price: 5 }], payment_type: 'cash', paid: 100, local_id: 'promo-s5', approver: { username: adminUser, password: 'Str0ng!Pass1' } }, cashierTok);
  ok(r.status === 200 && r.body.duplicate === true, 'إعادة الإرسال idempotent');
  // مدير مستأجر آخر لا يعتمد
  r = await call('POST', '/api/sales', { items: [{ product_id: promoProd.id, qty: 1, unit_price: 5 }], payment_type: 'cash', paid: 100, local_id: 'promo-s6', approver: { username: 'admin', password: 'Admin!B-Pass1' } }, cashierTok);
  ok(r.status === 403, 'مدير مستأجر آخر لا يعتمد');
  // إيقاف العرض يعيد السعر الأصلي
  r = await call('PUT', '/api/promotions/' + promo1.id, { is_active: false }, A);
  ok(r.status === 200 && r.body.data.is_active === false, 'إيقاف العرض');
  r = await call('POST', '/api/sales', { items: [{ product_id: promoProd.id, qty: 1 }], payment_type: 'cash', paid: 100, local_id: 'promo-s7' }, cashierTok);
  ok(r.status === 200 && near(r.body.data.total, 10), 'بعد الإيقاف يعود السعر الأصلي', r.body);
  // عرض تصنيف بسعر ثابت + منتهي لا يُطبّق
  r = await call('POST', '/api/promotions', { name: 'مشروبات 7', kind: 'fixed_price', value: 7, category: 'مشروبات' }, A);
  ok(r.status === 200, 'عرض تصنيف بسعر ثابت');
  r = await call('POST', '/api/promotions', { name: 'منتهي', kind: 'fixed_price', value: 1, product_id: promoProd.id, starts_at: '2020-01-01', ends_at: '2020-02-01' }, A);
  ok(r.status === 200, 'عرض منتهي يُنشأ');
  r = await call('POST', '/api/sales', { items: [{ product_id: promoProd.id, qty: 1 }], payment_type: 'cash', paid: 100, local_id: 'promo-s8' }, cashierTok);
  ok(r.status === 200 && near(r.body.data.total, 7), 'عرض التصنيف يُطبّق والمنتهي لا', r.body);
  r = await call('GET', '/api/promotions', null, A);
  ok(r.status === 200 && r.body.data.length >= 3 && r.body.data.some(x => x.running), 'قائمة العروض مع حالة التشغيل');
  r = await call('GET', '/api/promotions', null, B);
  ok(r.status === 200 && r.body.data.length === 0, 'عزل العروض بين المستأجرين');

  // ----- الدفع الإلكتروني (MyPay) بخادم وهمي يحاكي الاستجابات الموثقة -----
  console.log('\n● MyPay');
  const crypto = require('crypto');
  const mockCalls = []; let mockFailCreate = false;
  const mock = require('http').createServer((rq, rs) => {
    let b = ''; rq.on('data', d => b += d); rq.on('end', () => {
      const body = b ? JSON.parse(b) : {}; mockCalls.push({ url: rq.url, auth: rq.headers.authorization, body });
      rs.setHeader('Content-Type', 'application/json');
      if (rq.url === '/authentication/token') return rs.end(JSON.stringify(body.client_id === 'cid-test' && body.secret_id === 'csec-test' ? { type: 'success', data: { access_token: 'AT1', expire_time: 600 } } : { type: 'error' }));
      if (rq.url === '/payment/create') {
        if (mockFailCreate || rq.headers.authorization !== 'Bearer AT1') { rs.statusCode = 400; return rs.end(JSON.stringify({ type: 'error' })); }
        return rs.end(JSON.stringify({ type: 'success', data: { token: 'TOK' + mockCalls.length, payment_url: 'https://mypay.ly/pay/v1/user/payment/preview/TOK' + mockCalls.length } }));
      }
      rs.statusCode = 404; rs.end('{}');
    });
  });
  await new Promise(r => mock.listen(0, '127.0.0.1', r));
  process.env.MYPAY_BASE_URL = `http://127.0.0.1:${mock.address().port}`;
  async function sendHook(ev, { secret = 'whsec', sig } = {}) {
    const raw = JSON.stringify(ev);
    const res = await fetch(base + '/api/payments/webhook', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-MyPay-Signature': sig !== undefined ? sig : crypto.createHmac('sha256', secret).update(raw).digest('hex') }, body: raw });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  }
  const tA = (await q('SELECT id FROM tenants ORDER BY created_at LIMIT 1'))[0].id;

  r = await call('GET', '/api/payments/plans', null, A);
  ok(r.status === 200 && r.body.enabled === false && r.body.data.length === 0, 'الدفع الإلكتروني معطّل قبل ضبط المفاتيح');
  r = await call('POST', '/api/payments/checkout', { plan: 'MONTH' }, A);
  ok(r.status === 503, 'checkout بلا إعداد → 503');
  const ownerTok = O;
  r = await call('PUT', '/api/payments/plan-prices', { plan: 'MONTH', price: 50 }, A);
  ok(r.status === 403, 'مدير المتجر لا يحدد الأسعار');
  r = await call('PUT', '/api/payments/plan-prices', { plan: 'LIFE', price: 50 }, ownerTok);
  ok(r.status === 400, 'باقة غير قابلة للبيع الإلكتروني مرفوضة');
  r = await call('PUT', '/api/payments/plan-prices', { plan: 'MONTH', price: -5 }, ownerTok);
  ok(r.status === 400, 'سعر سالب مرفوض');
  r = await call('PUT', '/api/payments/plan-prices', { plan: 'MONTH', price: 50 }, ownerTok);
  ok(r.status === 200, 'المالك يحدد سعر الشهري');
  Object.assign(process.env, { MYPAY_CLIENT_ID: 'cid-test', MYPAY_CLIENT_SECRET: 'csec-test', MYPAY_WEBHOOK_SECRET: 'whsec', PUBLIC_BASE_URL: 'https://shop.example' });

  Object.assign(process.env, { MYPAY_CLIENT_ID: '-', MYPAY_CLIENT_SECRET: '-', MYPAY_WEBHOOK_SECRET: '-', PUBLIC_BASE_URL: '-' });
  r = await call('GET', '/api/payments/plans', null, A);
  ok(r.body.enabled === false, 'قيم MyPay الوهمية («-») لا تُفعّل الدفع');
  Object.assign(process.env, { MYPAY_CLIENT_ID: 'cid-test', MYPAY_CLIENT_SECRET: 'csec-test', MYPAY_WEBHOOK_SECRET: 'whsec', PUBLIC_BASE_URL: 'https://shop.example' });
  r = await call('GET', '/api/payments/plans', null, A);
  ok(r.body.enabled && r.body.data.length === 1 && r.body.data[0].price === 50, 'الباقات المتاحة تظهر بعد الإعداد', r.body);
  r = await call('POST', '/api/payments/checkout', { plan: 'YEAR' }, A);
  ok(r.status === 400, 'باقة بلا سعر غير متاحة');
  r = await call('POST', '/api/payments/checkout', { plan: 'MONTH', amount: 1 }, cashierTok);
  ok(r.status === 403, 'الكاشير لا يبدأ دفعاً');
  r = await call('POST', '/api/payments/checkout', { plan: 'MONTH', amount: 1 }, A);
  ok(r.status === 200 && /^https:\/\/mypay\.ly\//.test(r.body.payment_url), 'checkout ينشئ طلباً ويعيد رابط الدفع', r.body);
  const mp_ord = (await q('SELECT * FROM payment_orders WHERE id=$1', [r.body.order_id]))[0];
  ok(parseFloat(mp_ord.amount) === 50 && mp_ord.status === 'pending' && mp_ord.mypay_token, 'المبلغ من سعر الخادم (تجاهل amount=1 من العميل)', mp_ord);
  const create = mockCalls.filter(c => c.url === '/payment/create').pop();
  ok(create.body.amount === '50.00' && create.body.currency === 'LYD' && create.body.custom === mp_ord.id && create.body.return_url === 'https://shop.example/pay-result.html', 'الطلب المرسل لـ MyPay صحيح', create.body);
  r = await call('POST', '/api/payments/checkout', { plan: 'MONTH' }, A);
  ok(mockCalls.filter(c => c.url === '/authentication/token').length === 1, 'رمز الدخول يُخزَّن ولا يُطلب كل مرة');

  const mp_endBefore = new Date((await q('SELECT subscription_end FROM tenants WHERE id=$1', [tA]))[0].subscription_end);
  const evOk = { event: 'payment.success', type: 'QR_PAY', transaction_id: 'TX-1', token: mp_ord.mypay_token, trx_ref: 'REF-1', status: 'success', gateway: 'MOAMALAT', amount: 50.0, currency: 'LYD' };
  let mp_h = await sendHook(evOk, { sig: 'deadbeef' });
  ok(mp_h.status === 401, 'توقيع خاطئ مرفوض');
  mp_h = await sendHook(evOk, { secret: 'other' });
  ok(mp_h.status === 401, 'توقيع بسر مختلف مرفوض');
  mp_h = await sendHook(evOk, { sig: '' });
  ok(mp_h.status === 401, 'بدون توقيع مرفوض');
  ok((await q('SELECT status FROM payment_orders WHERE id=$1', [mp_ord.id]))[0].status === 'pending', 'الطلب يبقى معلقاً بعد الرفض');
  r = await call('GET', '/api/payments/status?token=' + mp_ord.mypay_token, null, A);
  ok(r.body.order && r.body.order.status === 'pending', 'صفحة العودة وحدها لا تفعّل شيئاً');

  mp_h = await sendHook({ ...evOk, amount: 5 });
  ok(mp_h.status === 200 && mp_h.body.status === 'mismatch', 'مبلغ مختلف ⇒ mismatch بلا تفعيل', mp_h.body);
  ok(new Date((await q('SELECT subscription_end FROM tenants WHERE id=$1', [tA]))[0].subscription_end).getTime() === mp_endBefore.getTime(), 'لم يتغير الاشتراك بعد mismatch');

  // طلب ثانٍ للدفع الناجح
  r = await call('POST', '/api/payments/checkout', { plan: 'MONTH' }, A);
  const ord2 = (await q('SELECT * FROM payment_orders WHERE id=$1', [r.body.order_id]))[0];
  const ev2 = { ...evOk, token: ord2.mypay_token, transaction_id: 'TX-2', trx_ref: 'REF-2' };
  mp_h = await sendHook(ev2);
  ok(mp_h.status === 200 && mp_h.body.status === 'paid', 'إشعار صحيح ⇒ paid', mp_h.body);
  const mp_endAfter = new Date((await q('SELECT subscription_end FROM tenants WHERE id=$1', [tA]))[0].subscription_end);
  ok(Math.abs((mp_endAfter - mp_endBefore) - 30 * 24 * 3600 * 1000) < 5000, 'تمديد 30 يوماً بالضبط');
  mp_h = await sendHook(ev2);
  ok(mp_h.status === 200 && mp_h.body.duplicate === true, 'إعادة الإشعار لا تُحتسب');
  const mp_endAgain = new Date((await q('SELECT subscription_end FROM tenants WHERE id=$1', [tA]))[0].subscription_end);
  ok(mp_endAgain.getTime() === mp_endAfter.getTime(), 'لا تمديد مزدوج');
  const par = await Promise.all([1, 2, 3, 4].map(() => sendHook(ev2)));
  ok(par.every(x => x.status === 200) && new Date((await q('SELECT subscription_end FROM tenants WHERE id=$1', [tA]))[0].subscription_end).getTime() === mp_endAfter.getTime(), 'إشعارات متزامنة: لا تمديد إضافي');

  // transaction_id مستخدم في طلب آخر
  r = await call('POST', '/api/payments/checkout', { plan: 'MONTH' }, A);
  const ord3 = (await q('SELECT * FROM payment_orders WHERE id=$1', [r.body.order_id]))[0];
  mp_h = await sendHook({ ...evOk, token: ord3.mypay_token, transaction_id: 'TX-2' });
  ok(mp_h.body.status === 'mismatch', 'إعادة استخدام transaction_id ⇒ mismatch');
  mp_h = await sendHook({ ...evOk, token: 'UNKNOWN' });
  ok(mp_h.status === 200 && mp_h.body.ignored === 'unknown_order', 'رمز غير معروف يُتجاهل بـ200');
  r = await call('POST', '/api/payments/checkout', { plan: 'MONTH' }, A);
  const ord4 = (await q('SELECT * FROM payment_orders WHERE id=$1', [r.body.order_id]))[0];
  mp_h = await sendHook({ event: 'payment.failed', token: ord4.mypay_token, status: 'failed', transaction_id: 'TX-4', amount: 50, currency: 'LYD' });
  ok(mp_h.body.status === 'failed' && (await q('SELECT status FROM payment_orders WHERE id=$1', [ord4.id]))[0].status === 'failed', 'إشعار فشل يضع الطلب failed');
  // عزل المتاجر
  r = await call('GET', '/api/payments/status?token=' + ord2.mypay_token, null, B);
  ok(r.status === 200 && r.body.order === null, 'متجر آخر لا يرى طلبك');
  r = await call('GET', '/api/payments/orders', null, A);
  ok(r.status === 200 && r.body.data.length >= 4 && r.body.data.some(x => x.status === 'paid'), 'سجل طلبات المتجر');
  // فشل البوابة
  mockFailCreate = true;
  r = await call('POST', '/api/payments/checkout', { plan: 'MONTH' }, A);
  ok(r.status === 502, 'فشل البوابة ⇒ 502 والطلب failed');
  mockFailCreate = false;
  // اشتراك منتهٍ ما زال يستطيع الدفع
  await q("UPDATE tenants SET subscription_end = NOW() - INTERVAL '2 days' WHERE id=$1", [tA]);
  r = await call('POST', '/api/payments/checkout', { plan: 'MONTH' }, A);
  ok(r.status === 200, 'المتجر المنتهي اشتراكه يستطيع بدء الدفع');
  const ord5 = (await q('SELECT * FROM payment_orders WHERE id=$1', [r.body.order_id]))[0];
  await sendHook({ ...evOk, token: ord5.mypay_token, transaction_id: 'TX-5' });
  const mp_revived = new Date((await q('SELECT subscription_end FROM tenants WHERE id=$1', [tA]))[0].subscription_end);
  ok(Math.abs(mp_revived - Date.now() - 30 * 24 * 3600 * 1000) < 10000, 'التمديد من الآن إذا كان منتهياً');
  // ----- تجديد عام برمز المتجر (المنتهي لا يدخل) -----
  r = await call('GET', '/api/payments/public-plans');
  ok(r.status === 200 && r.body.enabled && r.body.data.length === 1, 'الباقات العامة بلا تسجيل دخول');
  r = await call('POST', '/api/payments/renew', { plan: 'MONTH', tenant_code: 'NOPE' });
  ok(r.status === 400 && r.body.code === 'TENANT_CODE_REQUIRED', 'رمز متجر مجهول مرفوض');
  r = await call('POST', '/api/payments/renew', { plan: 'MONTH', tenant_code: tenantA.tenant_code, amount: 1 });
  ok(r.status === 200 && /mypay\.ly/.test(r.body.payment_url), 'تجديد عام برمز المتجر', r.body);
  const ordR = (await q('SELECT * FROM payment_orders WHERE id=$1', [r.body.order_id]))[0];
  ok(parseFloat(ordR.amount) === 50 && ordR.tenant_id === tenantA.id && ordR.created_by === null, 'الطلب العام بسعر الخادم ومرتبط بالمتجر الصحيح');
  r = await call('GET', '/api/payments/public-status?token=' + ordR.mypay_token);
  ok(r.body.order && r.body.order.status === 'pending' && !('tenant_id' in r.body.order), 'حالة عامة بلا تسريب بيانات');
  await sendHook({ ...evOk, token: ordR.mypay_token, transaction_id: 'TX-R' });
  r = await call('GET', '/api/payments/public-status?token=' + ordR.mypay_token);
  ok(r.body.order.status === 'paid', 'التجديد العام يُفعَّل بالإشعار');
  mock.close();

  // ----- واجهة الدعم (Ops API) -----
  console.log('\n● Ops API');
  const OPSK = 'k'.repeat(40);
  const ops = (m, u, b, key = OPSK, actor = 'support@test') => call(m, '/api/ops' + u, b, null, { 'X-Ops-Key': key, 'X-Ops-Actor': actor });
  delete process.env.OPS_API_KEY;
  r = await ops('GET', '/summary');
  ok(r.status === 503, 'بدون OPS_API_KEY الواجهة معطلة');
  process.env.OPS_API_KEY = OPSK;
  r = await ops('GET', '/summary', null, 'wrong'.repeat(10));
  ok(r.status === 401, 'مفتاح خاطئ مرفوض');
  r = await call('GET', '/api/ops/summary', null, A);
  ok(r.status === 401, 'JWT مدير متجر لا يفتح واجهة الدعم');
  r = await ops('GET', '/summary');
  ok(r.status === 200 && r.body.data.tenants.total >= 2 && r.body.data.payments.revenue_total >= 100, 'ملخص: عملاء وإيرادات', r.body);
  r = await ops('GET', '/tenants?search=' + encodeURIComponent('متجر'));
  ok(r.status === 200 && r.body.data.length >= 2 && r.body.data[0].state, 'قائمة العملاء مع الحالة');
  const opsT = r.body.data.find(x => x.id === tenantA.id);
  r = await ops('GET', '/tenants?status=expired');
  ok(r.status === 200 && Array.isArray(r.body.data), 'فلترة حسب الحالة');
  r = await ops('GET', '/tenants/' + tenantA.id);
  ok(r.status === 200 && r.body.data.users.length >= 1 && r.body.data.payments.length >= 1 && !JSON.stringify(r.body).includes('password_hash'), 'تفاصيل عميل: مستخدمون ومدفوعات بلا أسرار');
  r = await ops('GET', '/tenants/not-a-uuid');
  ok(r.status === 404, 'معرّف غير صالح 404');
  const e0 = new Date((await q('SELECT subscription_end FROM tenants WHERE id=$1', [tenantA.id]))[0].subscription_end);
  r = await ops('POST', `/tenants/${tenantA.id}/renew`, { days: 10, note: 'تعويض' });
  const e1 = new Date((await q('SELECT subscription_end FROM tenants WHERE id=$1', [tenantA.id]))[0].subscription_end);
  ok(r.status === 200 && Math.abs((e1 - Math.max(e0, Date.now())) - 10 * 864e5) < 5000, 'تجديد 10 أيام');
  r = await ops('POST', `/tenants/${tenantA.id}/renew`, { days: -3 });
  ok(r.status === 400, 'أيام سالبة مرفوضة');
  r = await ops('POST', `/tenants/${tenantA.id}/suspend`, { suspend: true, reason: 'اختبار' });
  ok(r.status === 200 && (await q('SELECT is_suspended FROM tenants WHERE id=$1', [tenantA.id]))[0].is_suspended, 'إيقاف عميل');
  r = await call('GET', '/api/products', null, A);
  ok(r.status === 403, 'العميل الموقوف يُمنع فعلاً');
  r = await ops('POST', `/tenants/${tenantA.id}/suspend`, { suspend: false });
  r = await call('GET', '/api/products', null, A);
  ok(r.status === 200 || r.status === 401, 'إعادة التفعيل');
  r = await ops('POST', `/tenants/${tenantA.id}/reset-password`, { username: 'cash9' });
  const tmpPw = r.body.data && r.body.data.temp_password;
  ok(r.status === 200 && tmpPw && tmpPw.length >= 12, 'كلمة مرور مؤقتة عشوائية', r.body);
  r = await call('POST', '/api/auth/login', { username: 'cash9', password: tmpPw, tenant_code: tenantA.tenant_code });
  ok(r.status === 200, 'الدخول بالكلمة المؤقتة ينجح');
  r = await call('GET', '/api/products', null, cashierTok);
  ok(r.status === 401, 'الجلسة القديمة أُبطلت بعد إعادة التعيين');
  r = await ops('POST', `/tenants/${tenantA.id}/reset-password`, { username: 'nobody' });
  ok(r.status === 404, 'مستخدم غير موجود');
  r = await ops('POST', '/license-codes', { plan: 'MONTH', count: 2 });
  ok(r.status === 200 && r.body.data.codes.length === 2, 'توليد أكواد من لوحة الدعم');
  // ----- إدارة الأكواد: ملاحظة + قائمة + إتلاف -----
  r = await ops('POST', '/license-codes', { plan: 'WEEK', count: 2, note: 'عميل واتساب', tenant_id: tenantA.id });
  const cdItems = r.body.data && r.body.data.items;
  ok(r.status === 200 && cdItems.length === 2 && cdItems[0].id && cdItems[0].code, 'توليد أكواد مع معرّف وملاحظة');
  r = await ops('GET', '/license-codes?status=unused');
  ok(r.status === 200 && r.body.data.some(x => x.id === cdItems[0].id && x.note === 'عميل واتساب' && x.state === 'unused'), 'قائمة الأكواد غير المستخدمة');
  ok(!JSON.stringify(r.body).includes(cdItems[0].code), 'القائمة لا تكشف الكود الأصلي');
  r = await ops('POST', `/license-codes/${cdItems[0].id}/revoke`, {});
  ok(r.status === 200, 'إتلاف كود غير مستخدم');
  r = await ops('POST', `/license-codes/${cdItems[0].id}/revoke`, {});
  ok(r.status === 400, 'لا يُتلف الكود مرتين');
  r = await call('POST', '/api/subscription/activate', { code: cdItems[0].code, tenant_code: tenantA.tenant_code });
  ok(r.status === 400, 'الكود المتلَف لا يُفعَّل');
  r = await call('POST', '/api/subscription/activate', { code: cdItems[1].code, tenant_code: tenantA.tenant_code });
  ok(r.status === 200, 'الكود السليم يُفعَّل');
  r = await ops('POST', `/license-codes/${cdItems[1].id}/revoke`, {});
  ok(r.status === 400, 'لا يُتلف كود مستخدم');
  r = await ops('GET', '/license-codes?status=used');
  ok(r.body.data.some(x => x.id === cdItems[1].id && x.state === 'used'), 'قائمة الأكواد المستخدمة');
  r = await ops('GET', '/license-codes?status=revoked');
  ok(r.body.data.some(x => x.id === cdItems[0].id), 'قائمة الأكواد المتلفة');
  r = await call('GET', '/api/payments/public-plans');
  ok(r.body.whatsapp === '218922227299', 'رقم واتساب الدعم في الواجهة العامة');
  r = await ops('GET', '/payments?status=paid');
  ok(r.status === 200 && r.body.data.length >= 1 && r.body.data.every(x => x.status === 'paid'), 'قائمة المدفوعات مع الفلتر');
  r = await ops('GET', '/audit');
  ok(r.status === 200 && r.body.data.some(x => x.action === 'renew' && x.actor === 'support@test') && r.body.data.some(x => x.action === 'reset_password'), 'سجل التدقيق يحفظ المنفّذ');
  ok(!JSON.stringify(r.body).includes(tmpPw), 'السجل لا يحفظ كلمة المرور المؤقتة');

  // ----- دخول الكاشير بمسح QR -----
  console.log('\n● QR login');
  const qrExtract = (url) => url.split('#qr=')[1];
  const cashRow = (await q("SELECT id, branch_id FROM users WHERE tenant_id=$1 AND username='cash9'", [tenantA.id]))[0];
  const qrCreate = (uid, tok) => call('POST', '/api/qr/create', { user_id: uid }, tok);
  const qrRedeem = (token, device_id) => call('POST', '/api/qr/redeem', { token, device_id });
  const adminRow = (await q("SELECT id FROM users WHERE tenant_id=$1 AND role='tenant_admin' LIMIT 1", [tenantA.id]))[0];
  let loginC = await call('POST', '/api/auth/login', { username: 'cash9', password: (await call('POST', `/api/ops/tenants/${tenantA.id}/reset-password`, { username: 'cash9' }, null, { 'X-Ops-Key': 'k'.repeat(40), 'X-Ops-Actor': 't' })).body.data.temp_password, tenant_code: tenantA.tenant_code });
  const cashTok2 = loginC.body.token;
  r = await qrCreate(cashRow.id, cashTok2);
  ok(r.status === 403, 'الكاشير لا ينشئ رموز QR');
  r = await qrCreate(adminRow.id, A);
  ok(r.status === 403, 'لا QR لحسابات المدراء');
  r = await qrCreate(cashRow.id, B);
  ok(r.status === 404, 'مدير متجر آخر لا ينشئ لمستخدمك');
  r = await qrCreate('bad-id', A);
  ok(r.status === 400, 'معرّف غير صالح');
  r = await qrCreate(cashRow.id, A);
  ok(r.status === 200 && r.body.data.url.includes('/#qr=') && r.body.data.minutes === 10, 'المدير ينشئ رمز QR', r.body);
  const qrTok = qrExtract(r.body.data.url);
  const stored = await q('SELECT token_hash FROM device_login_tokens WHERE tenant_id=$1', [tenantA.id]);
  ok(stored.length >= 1 && !JSON.stringify(stored).includes(qrTok), 'الرمز الخام لا يُخزَّن (مجزّأ فقط)');
  r = await qrRedeem('x'.repeat(43), 'dev-qr-test-1');
  ok(r.status === 401, 'رمز عشوائي مرفوض');
  r = await qrRedeem('short', 'dev-qr-test-1');
  ok(r.status === 401, 'رمز مشوّه مرفوض');
  r = await qrRedeem(qrTok, 'dev-qr-test-1');
  ok(r.status === 200 && r.body.user.role === 'cashier' && r.body.user.username === 'cash9' && r.body.token, 'المسح يسجّل دخول الكاشير', r.body);
  const qrSession = r.body.token;
  const dev = await q("SELECT branch_id, is_active FROM branch_devices WHERE tenant_id=$1 AND device_id='dev-qr-test-1'", [tenantA.id]);
  ok(dev.length === 1 && dev[0].branch_id === cashRow.branch_id && dev[0].is_active, 'الجهاز سُجّل تلقائياً في فرع الكاشير');
  r = await call('GET', '/api/products', null, qrSession);
  ok(r.status === 200, 'جلسة QR تعمل');
  const dec = require('jsonwebtoken').decode(qrSession);
  ok(dec.exp - dec.iat >= 6 * 86400, 'جلسة الجهاز 7 أيام');
  r = await qrRedeem(qrTok, 'dev-qr-test-2');
  ok(r.status === 401, 'الرمز لا يُستعمل مرتين');
  const par2 = await qrCreate(cashRow.id, A);
  const parTok = qrExtract(par2.body.data.url);
  const parRes = await Promise.all([1, 2, 3, 4, 5].map(() => qrRedeem(parTok, 'dev-race')));
  ok(parRes.filter(x => x.status === 200).length === 1, 'سباق: نجاح واحد فقط من 5 مسحات متزامنة', parRes.map(x => x.status));
  // انتهاء
  r = await qrCreate(cashRow.id, A); const expTok = qrExtract(r.body.data.url);
  await q("UPDATE device_login_tokens SET expires_at = NOW() - INTERVAL '1 minute' WHERE token_hash = encode(sha256($1::bytea),'hex')", [expTok]);
  r = await qrRedeem(expTok, 'dev-exp');
  ok(r.status === 401, 'الرمز المنتهي مرفوض');
  // حساب معطل
  r = await qrCreate(cashRow.id, A); const disTok = qrExtract(r.body.data.url);
  await q('UPDATE users SET is_active=FALSE WHERE id=$1', [cashRow.id]);
  r = await qrRedeem(disTok, 'dev-dis');
  ok(r.status === 403, 'حساب معطل لا يدخل بالـ QR');
  r = await qrCreate(cashRow.id, A);
  ok(r.status === 400, 'لا يُنشأ QR لحساب معطل');
  await q('UPDATE users SET is_active=TRUE WHERE id=$1', [cashRow.id]);
  // إبطال الجلسة بتغيير token_version
  await q('UPDATE users SET token_version = token_version + 1 WHERE id=$1', [cashRow.id]);
  r = await call('GET', '/api/products', null, qrSession);
  ok(r.status === 401, 'تغيير كلمة المرور/الإبطال يقطع جلسة الجهاز');
  // متجر موقوف
  r = await qrCreate(cashRow.id, A); const susTok = qrExtract(r.body.data.url);
  await q('UPDATE tenants SET is_suspended=TRUE WHERE id=$1', [tenantA.id]);
  r = await qrRedeem(susTok, 'dev-sus');
  ok(r.status === 403 && r.body.code === 'TENANT_SUSPENDED', 'متجر موقوف لا يدخل');
  await q('UPDATE tenants SET is_suspended=FALSE WHERE id=$1', [tenantA.id]);
  // مدير فرع آخر
  r = await call('POST', '/api/branches', { name: 'فرع QR', branch_code: 'BRQR1' }, A);
  const brQr = r.body.data && r.body.data.id;
  if (brQr) {
    await call('POST', '/api/users', { username: 'mgrqr', password: 'Mgr!Pass12345', full_name: 'مدير فرع', role: 'branch_manager', branch_id: brQr }, A);
    const mg = await call('POST', '/api/auth/login', { username: 'mgrqr', password: 'Mgr!Pass12345', tenant_code: tenantA.tenant_code });
    r = await qrCreate(cashRow.id, mg.body.token);
    ok(r.status === 403, 'مدير فرع آخر لا ينشئ QR لكاشير فرعٍ غيره');
  } else ok(true, 'تخطي اختبار مدير الفرع (لا فرع إضافي)');

  console.log(`\n══════════ النتيجة: ${passed} نجح، ${failed} فشل ══════════`);
  if (failed) console.log('الفاشلة:\n - ' + failures.join('\n - '));
  server.close(); await pool.end();
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error('💥 خطأ في الاختبار:', e); process.exit(2); });
