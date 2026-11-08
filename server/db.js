require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const { Pool } = require('pg');

const { poolConfig } = require('./lib/dbconfig');
const pool = new Pool(poolConfig({
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
}));

pool.on('error', (err) => {
  console.error('❌ خطأ غير متوقع في قاعدة البيانات:', err);
});

// دالة استعلام مبسطة
async function query(text, params) {
  const start = Date.now();
  const res = await pool.query(text, params);
  const duration = Date.now() - start;
  if (duration > 1000) {
    console.warn(`⚠️ استعلام بطيء (${duration}ms):`, text.substring(0, 80));
  }
  return res;
}

// دالة معاملة (transaction)
async function transaction(callback) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

// اختبار الاتصال
async function testConnection() {
  try {
    const r = await query('SELECT NOW() AS now');
    console.log('✅ قاعدة البيانات متصلة:', r.rows[0].now);
    return true;
  } catch (e) {
    console.error('❌ فشل الاتصال بقاعدة البيانات:', e.message);
    return false;
  }
}

module.exports = { pool, query, transaction, testConnection };
