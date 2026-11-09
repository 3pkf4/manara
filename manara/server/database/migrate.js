/**
 * مشغّل الهجرات: يطبّق ملفات migrations/*.sql بالترتيب مرة واحدة لكل ملف.
 * الاستخدام:  node server/database/migrate.js
 */
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

async function migrate(pool, log = console.log) {
  const dir = path.join(__dirname, 'migrations');
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.sql')).sort();
  const client = await pool.connect();
  try {
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      name VARCHAR(200) PRIMARY KEY,
      applied_at TIMESTAMPTZ DEFAULT NOW()
    )`);
    const done = new Set((await client.query('SELECT name FROM schema_migrations')).rows.map(r => r.name));

    // قاعدة قديمة (أُنشئت قبل وجود هذا المشغّل): نُسجّل الهجرات التي أثرها موجود فعلاً كمطبّقة
    if (done.size === 0) {
      const probes = {
        '001_schema.sql': "SELECT to_regclass('public.tenants') IS NOT NULL AS ok",
        '002_setup.sql': "SELECT to_regclass('public.system_setup') IS NOT NULL AS ok",
        '003_branches.sql': "SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='products' AND column_name='branch_id') AS ok",
        '004_devices.sql': "SELECT to_regclass('public.branch_devices') IS NOT NULL AS ok"
      };
      const legacy = (await client.query(probes['001_schema.sql'])).rows[0].ok;
      if (legacy) {
        for (const [name, sql] of Object.entries(probes)) {
          if ((await client.query(sql)).rows[0].ok) {
            await client.query('INSERT INTO schema_migrations (name) VALUES ($1) ON CONFLICT DO NOTHING', [name]);
            done.add(name);
            log(`ℹ️  ${name}: موجودة مسبقاً (قاعدة قديمة) — تم تسجيلها`);
          }
        }
      }
    }
    let applied = 0;
    for (const f of files) {
      if (done.has(f)) continue;
      log(`⏳ تطبيق ${f} ...`);
      try {
        await client.query(fs.readFileSync(path.join(dir, f), 'utf8'));
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [f]);
        applied++;
        log(`✅ ${f}`);
      } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        throw new Error(`فشلت الهجرة ${f}: ${e.message}`);
      }
    }
    if (!applied) log('ℹ️  قاعدة البيانات محدّثة');
    return applied;
  } finally {
    client.release();
  }
}

module.exports = { migrate };

if (require.main === module) {
  require('dotenv').config({ path: path.join(__dirname, '../../.env') });
  const pool = new Pool(require('../lib/dbconfig').poolConfig());
  migrate(pool)
    .then(async () => {
      const r = await pool.query('SELECT setup_token, is_completed FROM system_setup WHERE id = 1').catch(() => null);
      if (r && r.rows[0] && !r.rows[0].is_completed) {
        console.log('\n🔑 رمز الإعداد الأولي (يُستخدم مرة واحدة في صفحة /setup.html):');
        console.log('   ' + r.rows[0].setup_token + '\n');
      }
      await pool.end();
    })
    .catch(async e => { console.error('❌', e.message); await pool.end(); process.exit(1); });
}
