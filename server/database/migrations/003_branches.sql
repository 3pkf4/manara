-- =====================================================
-- Migration: عزل البيانات حسب الفرع
-- =====================================================

BEGIN;

-- 1. أضف عمود branch_id للمنتجات
ALTER TABLE products 
  ADD COLUMN IF NOT EXISTS branch_id UUID REFERENCES branches(id) ON DELETE CASCADE;

UPDATE products p 
SET branch_id = (
  SELECT b.id FROM branches b 
  WHERE b.tenant_id = p.tenant_id AND b.is_main = TRUE 
  LIMIT 1
)
WHERE p.branch_id IS NULL;

DO $$ 
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'products' AND column_name = 'branch_id' 
    AND is_nullable = 'NO'
  ) THEN
    ALTER TABLE products ALTER COLUMN branch_id SET NOT NULL;
  END IF;
END $$;

-- 2. العملاء
ALTER TABLE customers 
  ADD COLUMN IF NOT EXISTS branch_id UUID REFERENCES branches(id) ON DELETE CASCADE;

UPDATE customers c 
SET branch_id = (
  SELECT b.id FROM branches b 
  WHERE b.tenant_id = c.tenant_id AND b.is_main = TRUE 
  LIMIT 1
)
WHERE c.branch_id IS NULL;

DO $$ 
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'customers' AND column_name = 'branch_id' 
    AND is_nullable = 'NO'
  ) THEN
    ALTER TABLE customers ALTER COLUMN branch_id SET NOT NULL;
  END IF;
END $$;

-- 3. الموردين
ALTER TABLE suppliers 
  ADD COLUMN IF NOT EXISTS branch_id UUID REFERENCES branches(id) ON DELETE CASCADE;

UPDATE suppliers s 
SET branch_id = (
  SELECT b.id FROM branches b 
  WHERE b.tenant_id = s.tenant_id AND b.is_main = TRUE 
  LIMIT 1
)
WHERE s.branch_id IS NULL;

-- 4. الفهارس
CREATE INDEX IF NOT EXISTS idx_products_branch ON products(tenant_id, branch_id);
CREATE INDEX IF NOT EXISTS idx_customers_branch ON customers(tenant_id, branch_id);
CREATE INDEX IF NOT EXISTS idx_suppliers_branch ON suppliers(tenant_id, branch_id);
CREATE INDEX IF NOT EXISTS idx_products_barcode_branch ON products(tenant_id, branch_id, barcode);

COMMIT;

SELECT 
  'منتجات بدون فرع: ' || COUNT(*) AS check_products
FROM products WHERE branch_id IS NULL
UNION ALL
SELECT 
  'عملاء بدون فرع: ' || COUNT(*) 
FROM customers WHERE branch_id IS NULL
UNION ALL
SELECT 
  'فروع موجودة: ' || COUNT(*) 
FROM branches;
