-- =====================================================
-- 005: الإصدار 2 — إصلاحات هيكلية + ميزات جديدة
-- (آمنة للتشغيل أكثر من مرة على قواعد قديمة أو جديدة)
-- =====================================================

-- 1) الاشتراك: العمود كان مفقوداً من المخطط الأصلي، والنوع DATE لا يدعم الساعات
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS subscription_status VARCHAR(20) DEFAULT 'active';
DO $$
BEGIN
  IF (SELECT data_type FROM information_schema.columns
      WHERE table_name = 'tenants' AND column_name = 'subscription_end') = 'date' THEN
    ALTER TABLE tenants ALTER COLUMN subscription_end TYPE TIMESTAMPTZ USING subscription_end::timestamptz;
  END IF;
END $$;

-- 2) المستخدمون: إبطال الرموز فوراً + حصر الأدوار + فرادة اسم المالك
ALTER TABLE users ADD COLUMN IF NOT EXISTS token_version INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check
  CHECK (role IN ('owner','tenant_admin','branch_manager','cashier','warehouse','accountant')) NOT VALID;
CREATE UNIQUE INDEX IF NOT EXISTS uq_users_platform_username
  ON users(username) WHERE tenant_id IS NULL;

-- 3) عدّادات المستندات (بديل COUNT(*) الذي يسبب أرقاماً مكررة عند التزامن)
CREATE TABLE IF NOT EXISTS doc_counters (
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    doc_type  VARCHAR(10) NOT NULL,
    year      INTEGER NOT NULL,
    last_value INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (tenant_id, doc_type, year)
);

INSERT INTO doc_counters (tenant_id, doc_type, year, last_value)
SELECT tenant_id, 'INV', EXTRACT(YEAR FROM created_at)::int,
       COALESCE(MAX(NULLIF(substring(invoice_number from '(\d+)$'), '')::int), 0)
FROM invoices GROUP BY tenant_id, EXTRACT(YEAR FROM created_at)
ON CONFLICT DO NOTHING;

INSERT INTO doc_counters (tenant_id, doc_type, year, last_value)
SELECT tenant_id, 'RET', EXTRACT(YEAR FROM created_at)::int,
       COALESCE(MAX(NULLIF(substring(return_number from '(\d+)$'), '')::int), 0)
FROM returns GROUP BY tenant_id, EXTRACT(YEAR FROM created_at)
ON CONFLICT DO NOTHING;

-- 4) منع تكرار الفاتورة عند إعادة إرسالها من وضع عدم الاتصال
DO $$
BEGIN
  CREATE UNIQUE INDEX IF NOT EXISTS uq_invoices_local
    ON invoices(tenant_id, local_id) WHERE local_id IS NOT NULL;
EXCEPTION WHEN unique_violation THEN
  RAISE NOTICE 'تعذر إنشاء uq_invoices_local: توجد فواتير مكررة بنفس local_id. نظّفها يدوياً ثم أعد التشغيل.';
END $$;

-- 5) المنتجات: تاريخ الصلاحية + منع المخزون السالب
ALTER TABLE products ADD COLUMN IF NOT EXISTS expiry_date DATE;
ALTER TABLE products DROP CONSTRAINT IF EXISTS products_stock_nonneg;
ALTER TABLE products ADD CONSTRAINT products_stock_nonneg CHECK (stock >= 0) NOT VALID;
CREATE INDEX IF NOT EXISTS idx_products_expiry ON products(tenant_id, expiry_date) WHERE expiry_date IS NOT NULL;

-- 6) الفواتير: الباقي للزبون، نقاط الولاء، بيانات الإلغاء
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS change_amount DECIMAL(15,2) DEFAULT 0;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS points_earned INTEGER DEFAULT 0;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS points_redeemed INTEGER DEFAULT 0;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS shift_id UUID;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMPTZ;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS cancelled_by UUID REFERENCES users(id);

-- 7) العملاء: نقاط الولاء
ALTER TABLE customers ADD COLUMN IF NOT EXISTS points INTEGER NOT NULL DEFAULT 0;

-- 8) تحصيل ديون العملاء (سجل كامل بدل تعديل الرصيد فقط)
CREATE TABLE IF NOT EXISTS customer_payments (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    branch_id UUID REFERENCES branches(id),
    customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    user_id UUID REFERENCES users(id),
    amount DECIMAL(15,2) NOT NULL CHECK (amount > 0),
    method VARCHAR(20) NOT NULL DEFAULT 'cash',
    balance_before DECIMAL(15,2),
    balance_after DECIMAL(15,2),
    notes TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_cust_pay_customer ON customer_payments(customer_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_cust_pay_tenant ON customer_payments(tenant_id, created_at DESC);

-- 9) الورديات (إغلاق الصندوق)
CREATE TABLE IF NOT EXISTS shifts (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    branch_id UUID NOT NULL REFERENCES branches(id),
    user_id UUID NOT NULL REFERENCES users(id),
    status VARCHAR(10) NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
    opening_cash DECIMAL(15,2) NOT NULL DEFAULT 0,
    opened_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    closed_at TIMESTAMPTZ,
    expected_cash DECIMAL(15,2),
    counted_cash DECIMAL(15,2),
    difference DECIMAL(15,2),
    summary JSONB DEFAULT '{}'::jsonb,
    notes TEXT
);
CREATE INDEX IF NOT EXISTS idx_shifts_tenant ON shifts(tenant_id, opened_at DESC);
-- وردية مفتوحة واحدة فقط لكل مستخدم
CREATE UNIQUE INDEX IF NOT EXISTS uq_shift_open_per_user ON shifts(user_id) WHERE status = 'open';

-- 10) أكواد الترخيص (تُخزَّن مجزّأة؛ الكود الأصلي لا يُحفظ)
CREATE TABLE IF NOT EXISTS license_codes (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    code_hash VARCHAR(64) NOT NULL UNIQUE,
    code_hint VARCHAR(12),
    plan VARCHAR(20) NOT NULL,
    duration_minutes BIGINT NOT NULL CHECK (duration_minutes > 0),
    tenant_id UUID REFERENCES tenants(id) ON DELETE CASCADE,
    created_by UUID REFERENCES users(id),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    used_at TIMESTAMPTZ,
    used_by_tenant UUID REFERENCES tenants(id)
);
CREATE INDEX IF NOT EXISTS idx_license_codes_unused ON license_codes(used_at) WHERE used_at IS NULL;

-- 11) فهارس أداء للتقارير
CREATE INDEX IF NOT EXISTS idx_invoices_customer ON invoices(customer_id);
CREATE INDEX IF NOT EXISTS idx_invoice_items_invoice ON invoice_items(invoice_id);
CREATE INDEX IF NOT EXISTS idx_cash_ref ON cash_transactions(reference_id);
CREATE INDEX IF NOT EXISTS idx_cash_user_time ON cash_transactions(user_id, created_at);
