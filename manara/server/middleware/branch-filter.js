/**
 * Helper: تحديد فلتر الفرع حسب دور المستخدم
 * 
 * - owner: يرى كل شيء، أو يفلتر حسب query
 * - tenant_admin: يرى كل شيء، أو يفلتر حسب query
 * - branch_manager: فرعه فقط
 * - cashier, warehouse, accountant: فرعهم فقط
 */

function getBranchFilter(req) {
  // Owner
  if (req.user.role === 'owner') {
    const bId = req.query.branch_id || (req.body && req.body.branch_id);
    return bId 
      ? { filter: true, branchId: bId, scope: 'custom' }
      : { filter: false, scope: 'all' };
  }

  // Tenant admin
  if (req.user.role === 'tenant_admin') {
    const bId = req.query.branch_id || (req.body && req.body.branch_id);
    return bId 
      ? { filter: true, branchId: bId, scope: 'custom' }
      : { filter: false, scope: 'all' };
  }

  // باقي الأدوار → فرعهم فقط
  return { 
    filter: true, 
    branchId: req.branchId, 
    scope: 'own',
    required: true
  };
}

/**
 * تحديد الفرع للإدراج
 */
async function resolveBranchForInsert(req, query) {
  if (req.user.role === 'owner' || req.user.role === 'tenant_admin') {
    const bId = (req.body && req.body.branch_id) || req.query.branch_id;
    if (bId) return bId;

    // الفرع الرئيسي
    const main = await query(
      'SELECT id FROM branches WHERE tenant_id = $1 AND is_main = TRUE LIMIT 1',
      [req.tenantId]
    );
    return main.rows.length ? main.rows[0].id : null;
  }

  return req.branchId;
}

module.exports = { getBranchFilter, resolveBranchForInsert };
