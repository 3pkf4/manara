/**
 * إعداد الاتصال بقاعدة البيانات: DATABASE_URL (Render وأغلب الاستضافات) أو DB_HOST/DB_*.
 * DB_SSL=true يفعّل SSL (للاتصال الخارجي بقاعدة مُدارة؛ الاتصال الداخلي لا يحتاجه).
 */
function poolConfig(extra = {}) {
  const ssl = ['1', 'true', 'yes', 'on'].includes(String(process.env.DB_SSL || '').toLowerCase())
    ? { rejectUnauthorized: false } : undefined;
  if (process.env.DATABASE_URL) return { connectionString: process.env.DATABASE_URL, ssl, ...extra };
  return {
    host: process.env.DB_HOST, port: parseInt(process.env.DB_PORT) || 5432,
    database: process.env.DB_NAME, user: process.env.DB_USER, password: process.env.DB_PASSWORD, ssl, ...extra
  };
}
module.exports = { poolConfig };
