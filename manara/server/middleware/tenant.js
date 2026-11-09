// التأكد من أن المستخدم لا يستطيع الوصول لبيانات عميل آخر
function enforceTenant(req, res, next) {
  // المالك يمكنه الوصول لكل شيء (مع تمرير tenant_id يدوياً)
  if (req.user.role === 'owner') {
    req.effectiveTenantId = req.params.tenantId || req.query.tenantId || req.body?.tenant_id;
    return next();
  }
  // باقي المستخدمين مقيدون بمستأجرهم فقط
  req.effectiveTenantId = req.tenantId;
  next();
}

module.exports = { enforceTenant };
