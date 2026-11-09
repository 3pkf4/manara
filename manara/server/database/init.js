/**
 * تهيئة قاعدة البيانات:
 *   node server/database/init.js            → هجرات + حساب المالك
 *   node server/database/init.js --demo     → + متجر تجريبي (للتطوير فقط، مرفوض في الإنتاج)
 * كلمات المرور لا تُطبع إلا إذا وُلّدت عشوائياً الآن (تُعرض مرة واحدة).
 */
require('../lib/config');
const crypto = require('crypto');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const { migrate } = require('./migrate');
const { checkPasswordStrength } = require('../lib/password');

const pool = new Pool(require('../lib/dbconfig').poolConfig());
const randomPassword = () => crypto.randomBytes(9).toString('base64').replace(/[+/=]/g, 'x');

async function init() {
  const wantDemo = process.argv.includes('--demo') || process.env.SEED_DEMO === 'true';
  if (wantDemo && process.env.NODE_ENV === 'production') {
    throw new Error('المتجر التجريبي مرفوض في بيئة الإنتاج (NODE_ENV=production)');
  }
  console.log('\n🚀 تهيئة قاعدة البيانات...\n');
  await migrate(pool);

  // ---- حساب المالك ----
  const exists = await pool.query("SELECT id FROM users WHERE tenant_id IS NULL AND role = 'owner' LIMIT 1");
  if (!exists.rows.length) {
    let pw = process.env.OWNER_PASSWORD;
    let generated = false;
    if (!pw || checkPasswordStrength(pw) || pw.length < 10) {
      pw = randomPassword(); generated = true;
    }
    const hash = await bcrypt.hash(pw, 12);
    await pool.query(
      `INSERT INTO users (tenant_id, username, password_hash, full_name, email, role)
       VALUES (NULL, 'owner', $1, 'مالك المنظومة', $2, 'owner')`, [hash, process.env.OWNER_EMAIL || null]);
    console.log('✅ تم إنشاء حساب المالك: owner');
    if (generated) console.log(`   كلمة المرور (تظهر مرة واحدة فقط، احفظها وغيّرها): ${pw}`);
    else console.log('   كلمة المرور: القيمة الموجودة في OWNER_PASSWORD (احذفها من .env بعد التأكد)');
  } else console.log('ℹ️  حساب المالك موجود');

  // ---- متجر تجريبي (اختياري) ----
  if (wantDemo) {
    const has = await pool.query("SELECT id FROM tenants WHERE tenant_code = 'DEMO001'");
    if (!has.rows.length) {
      const tenantId = uuidv4(), branchId = uuidv4();
      const adminPw = randomPassword(), cashierPw = randomPassword();
      await pool.query(
        `INSERT INTO tenants (id, tenant_code, business_name, owner_name, owner_phone, owner_email, address, plan,
                              is_trial, subscription_status, trial_ends_at, subscription_end,
                              max_branches, max_users, max_products, license_key, api_key)
         VALUES ($1,'DEMO001','متجر المنارة التجريبي','المدير التجريبي','0910000000','demo@manara.local','طرابلس','pro',
                 TRUE,'active', NOW() + INTERVAL '90 days', NOW() + INTERVAL '90 days', 3, 10, 5000, $2, $3)`,
        [tenantId, 'DEMO-' + uuidv4().slice(0, 8).toUpperCase(), 'api_' + uuidv4().replace(/-/g, '')]);
      await pool.query(`INSERT INTO branches (id, tenant_id, branch_code, name, address, is_main)
                        VALUES ($1,$2,'BR001','الفرع الرئيسي','طرابلس',TRUE)`, [branchId, tenantId]);
      await pool.query(`INSERT INTO users (tenant_id, branch_id, username, password_hash, full_name, role) VALUES
                        ($1,$2,'admin',$3,'المدير العام','tenant_admin'), ($1,$2,'cashier',$4,'كاشير 1','cashier')`,
        [tenantId, branchId, await bcrypt.hash(adminPw, 10), await bcrypt.hash(cashierPw, 10)]);
      const products = [
        ['ورق A4', '1001', 'مكتبية', 15, 10, 100, 10, false], ['حبر HP 305', '1003', 'أحبار', 65, 45, 20, 5, false],
        ['دفتر 100 ورقة', '1005', 'مكتبية', 8.5, 5, 200, 20, false], ['قلم جاف أزرق', '1006', 'مكتبية', 2, 1, 500, 50, false],
        ['آلة حاسبة كاسيو', '1010', 'إلكترونيات', 85, 65, 10, 3, false], ['طباعة أبيض/أسود', 'S001', 'خدمات', 0.5, 0.1, 0, 0, true]
      ];
      for (const p of products) {
        await pool.query(`INSERT INTO products (tenant_id, branch_id, name, barcode, category, sell_price, cost_price, stock, min_stock, is_service)
                          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [tenantId, branchId, ...p]);
      }
      await pool.query(`INSERT INTO customers (tenant_id, branch_id, name, phone, address, balance, credit_limit)
                        VALUES ($1,$2,'أحمد محمد','0912345678','طرابلس',0,500), ($1,$2,'شركة الأمل','0925555555','بنغازي',1200,5000)`, [tenantId, branchId]);
      await pool.query(`INSERT INTO tenant_settings (tenant_id, setting_key, setting_value) VALUES
                        ($1,'print_footer','المنارة لخدمات الطباعة'), ($1,'tax_enabled','false')`, [tenantId]);
      console.log('\n✅ متجر تجريبي (DEMO001) — بيانات الدخول تظهر مرة واحدة:');
      console.log(`   admin / ${adminPw}\n   cashier / ${cashierPw}`);
    } else console.log('ℹ️  المتجر التجريبي موجود');
  }
  console.log('\n🎉 تمت التهيئة\n');
}

init().then(() => pool.end()).catch(async e => { console.error('❌', e.message); await pool.end(); process.exit(1); });
