-- إدارة الأكواد من لوحة المالك: ملاحظة (اسم العميل) + إتلاف الكود غير المستخدم
ALTER TABLE license_codes ADD COLUMN IF NOT EXISTS note VARCHAR(200);
ALTER TABLE license_codes ADD COLUMN IF NOT EXISTS revoked_at TIMESTAMPTZ;
