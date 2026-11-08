#!/usr/bin/env node
/**
 * توليد أكواد ترخيص من سطر الأوامر (للمالك):
 *   npm run gen-license -- MONTH 5            → 5 أكواد شهرية غير مربوطة بعميل
 *   npm run gen-license -- YEAR 1 CLIENT123456 → كود سنوي مربوط بعميل محدد
 * الخطط: DEMO2H | WEEK | MONTH | YEAR | LIFE
 * الأكواد تُعرض مرة واحدة هنا فقط (يُحفظ منها هاش SHA-256 في القاعدة).
 */
require('../lib/config');
const { Pool } = require('pg');
const { createCodes, PLANS } = require('../lib/license');

(async () => {
  const [plan, countArg, tenantCode] = process.argv.slice(2);
  if (!plan || !PLANS[plan.toUpperCase()]) {
    console.error('الاستخدام: gen-license <' + Object.keys(PLANS).join('|') + '> [العدد] [tenant_code]');
    process.exit(1);
  }
  const pool = new Pool(require('../lib/dbconfig').poolConfig());
  try {
    let tenantId = null;
    if (tenantCode) {
      const t = await pool.query('SELECT id FROM tenants WHERE UPPER(tenant_code) = $1', [tenantCode.toUpperCase()]);
      if (!t.rows.length) throw new Error('العميل غير موجود: ' + tenantCode);
      tenantId = t.rows[0].id;
    }
    const count = Math.min(200, Math.max(1, parseInt(countArg) || 1));
    const codes = await createCodes(pool, { plan: plan.toUpperCase(), count, tenantId });
    console.log(`\n${PLANS[plan.toUpperCase()].name} × ${count}${tenantCode ? ' — للعميل ' + tenantCode : ''}\n`);
    codes.forEach(c => console.log('  ' + c));
    console.log('\n⚠️  انسخها الآن؛ لا يمكن عرضها مرة أخرى.\n');
  } catch (e) { console.error('❌', e.message); process.exitCode = 1; }
  await pool.end();
})();
