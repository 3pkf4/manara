const { query } = require('../db');

// تسجيل نشاط في قاعدة البيانات
async function logActivity(req, action, entityType = null, entityId = null, details = {}) {
  try {
    if (!req.user) return;
    await query(
      `INSERT INTO activity_log (tenant_id, user_id, action, entity_type, entity_id, details, ip_address)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [req.tenantId, req.user.id, action, entityType, entityId, JSON.stringify(details), req.ip]
    );
  } catch (e) {
    console.error('Failed to log activity:', e.message);
  }
}

module.exports = { logActivity };
