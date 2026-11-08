/** سياسة كلمات المرور: 8 أحرف على الأقل، ولا تكون من الشائعة. يعيد نص الخطأ أو null. */
const COMMON = new Set(['12345678', '123456789', '1234567890', 'password', 'password1', 'admin123', 'admin1234',
  'qwerty123', '11111111', '00000000', 'iloveyou', 'manara123', 'abc12345', 'letmein1']);

function checkPasswordStrength(pw) {
  if (typeof pw !== 'string') return 'كلمة المرور غير صالحة';
  if (pw.length < 8) return 'كلمة المرور يجب أن تكون 8 أحرف على الأقل';
  if (pw.length > 128) return 'كلمة المرور طويلة جداً';
  if (COMMON.has(pw.toLowerCase())) return 'كلمة المرور شائعة وسهلة التخمين';
  if (/^(.)\1+$/.test(pw)) return 'كلمة المرور ضعيفة';
  return null;
}
module.exports = { checkPasswordStrength };
