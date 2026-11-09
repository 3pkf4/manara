/**
 * إنشاء حساب المالك تلقائياً عند أول تشغيل على استضافة بلا طرفية (shell):
 * يحدث فقط إن لم يوجد مالك وكانت OWNER_PASSWORD مضبوطة وقوية. لا تُولَّد كلمة سرّية ولا تُطبع.
 * بعد أول دخول غيّر كلمة المرور واحذف OWNER_PASSWORD من إعدادات الاستضافة.
 */
const bcrypt = require('bcryptjs');
const { checkPasswordStrength } = require('./password');

async function ensureOwner(pool) {
  const ex = await pool.query("SELECT 1 FROM users WHERE tenant_id IS NULL AND role = 'owner' LIMIT 1");
  if (ex.rows.length) { await markSetupDone(pool); return false; }
  const pw = process.env.OWNER_PASSWORD || '';
  if (pw.length < 10 || checkPasswordStrength(pw)) {
    console.warn('⚠️ لا يوجد حساب مالك. اضبط OWNER_PASSWORD (10 أحرف فأكثر وقوية) وأعد التشغيل لإنشائه.');
    return false;
  }
  const hash = await bcrypt.hash(pw, 12);
  await pool.query(
    `INSERT INTO users (tenant_id, username, password_hash, full_name, email, role)
     VALUES (NULL, 'owner', $1, 'مالك المنظومة', $2, 'owner')`, [hash, process.env.OWNER_EMAIL || null]);
  console.log("✅ أُنشئ حساب المالك (اسم المستخدم: owner). غيّر كلمة المرور بعد أول دخول واحذف OWNER_PASSWORD من الإعدادات.");
  await markSetupDone(pool);
  return true;
}
// في وضع SaaS يُنشئ المالك المتاجر من لوحة الإدارة؛ فلا حاجة لمعالج الإعداد الأولي (الذي يتطلب رمزاً مطبوعاً في الطرفية)
async function markSetupDone(pool) {
  await pool.query('UPDATE system_setup SET is_completed = TRUE WHERE id = 1 AND is_completed = FALSE').catch(() => {});
}
module.exports = { ensureOwner };
