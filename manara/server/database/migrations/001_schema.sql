-- =====================================================
-- منظومة المنارة - مخطط قاعدة البيانات الكامل
-- Multi-Tenant SaaS Architecture
-- =====================================================

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- =====================================================
-- 1. جدول المستأجرين (العملاء الذين يشترون المنظومة)
-- =====================================================
CREATE TABLE IF NOT EXISTS tenants (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_code VARCHAR(20) UNIQUE NOT NULL,
    business_name VARCHAR(200) NOT NULL,
    owner_name VARCHAR(200) NOT NULL,
    owner_phone VARCHAR(20) NOT NULL,
    owner_email VARCHAR(200),
    address TEXT,
    logo_url TEXT,
    
    plan VARCHAR(20) DEFAULT 'basic',
    subscription_start DATE DEFAULT CURRENT_DATE,
    subscription_end DATE,
    is_trial BOOLEAN DEFAULT TRUE,
    trial_ends_at DATE,
    
    is_active BOOLEAN DEFAULT TRUE,
    is_suspended BOOLEAN DEFAULT FALSE,
    suspension_reason TEXT,
    
    currency VARCHAR(3) DEFAULT 'LYD',
    language VARCHAR(5) DEFAULT 'ar',
    timezone VARCHAR(50) DEFAULT 'Africa/Tripoli',
    
    max_branches INTEGER DEFAULT 1,
    max_users INTEGER DEFAULT 3,
    max_products INTEGER DEFAULT 500,
    
    license_key VARCHAR(100) UNIQUE,
    api_key VARCHAR(100) UNIQUE,
    
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_tenants_code ON tenants(tenant_code);
CREATE INDEX IF NOT EXISTS idx_tenants_active ON tenants(is_active, is_suspended);

-- =====================================================
-- 2. جدول الفروع
-- =====================================================
CREATE TABLE IF NOT EXISTS branches (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    branch_code VARCHAR(20) NOT NULL,
    name VARCHAR(200) NOT NULL,
    address TEXT,
    phone VARCHAR(20),
    cash_balance DECIMAL(15,2) DEFAULT 0,
    is_active BOOLEAN DEFAULT TRUE,
    is_main BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(tenant_id, branch_code)
);

CREATE INDEX IF NOT EXISTS idx_branches_tenant ON branches(tenant_id);

-- =====================================================
-- 3. جدول المستخدمين
-- =====================================================
CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id UUID REFERENCES tenants(id) ON DELETE CASCADE,
    branch_id UUID REFERENCES branches(id) ON DELETE SET NULL,
    username VARCHAR(50) NOT NULL,
    password_hash VARCHAR(200) NOT NULL,
    full_name VARCHAR(200) NOT NULL,
    phone VARCHAR(20),
    email VARCHAR(200),
    role VARCHAR(30) NOT NULL DEFAULT 'cashier',
    permissions JSONB DEFAULT '{}'::jsonb,
    is_active BOOLEAN DEFAULT TRUE,
    last_login TIMESTAMPTZ,
    last_ip VARCHAR(45),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(tenant_id, username)
);

CREATE INDEX IF NOT EXISTS idx_users_tenant ON users(tenant_id);
CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);

-- =====================================================
-- 4. جدول الجلسات
-- =====================================================
CREATE TABLE IF NOT EXISTS sessions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    tenant_id UUID REFERENCES tenants(id) ON DELETE CASCADE,
    token_hash VARCHAR(200) NOT NULL,
    ip_address VARCHAR(45),
    user_agent TEXT,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);

-- =====================================================
-- 5. المنتجات
-- =====================================================
CREATE TABLE IF NOT EXISTS products (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    sku VARCHAR(100),
    barcode VARCHAR(100),
    name VARCHAR(300) NOT NULL,
    description TEXT,
    category VARCHAR(100) DEFAULT 'عام',
    cost_price DECIMAL(15,2) DEFAULT 0,
    sell_price DECIMAL(15,2) NOT NULL,
    wholesale_price DECIMAL(15,2) DEFAULT 0,
    stock DECIMAL(15,3) DEFAULT 0,
    min_stock DECIMAL(15,3) DEFAULT 5,
    unit VARCHAR(20) DEFAULT 'قطعة',
    is_service BOOLEAN DEFAULT FALSE,
    is_active BOOLEAN DEFAULT TRUE,
    image_url TEXT,
    tax_rate DECIMAL(5,2) DEFAULT 0,
    created_by UUID REFERENCES users(id),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_products_tenant ON products(tenant_id);
CREATE INDEX IF NOT EXISTS idx_products_barcode ON products(tenant_id, barcode);
CREATE INDEX IF NOT EXISTS idx_products_category ON products(tenant_id, category);
CREATE INDEX IF NOT EXISTS idx_products_active ON products(tenant_id, is_active);

-- =====================================================
-- 6. العملاء
-- =====================================================
CREATE TABLE IF NOT EXISTS customers (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    name VARCHAR(300) NOT NULL,
    phone VARCHAR(20),
    email VARCHAR(200),
    address TEXT,
    tax_number VARCHAR(50),
    balance DECIMAL(15,2) DEFAULT 0,
    credit_limit DECIMAL(15,2) DEFAULT 0,
    notes TEXT,
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_customers_tenant ON customers(tenant_id);
CREATE INDEX IF NOT EXISTS idx_customers_phone ON customers(tenant_id, phone);

-- =====================================================
-- 7. الموردون
-- =====================================================
CREATE TABLE IF NOT EXISTS suppliers (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    name VARCHAR(300) NOT NULL,
    phone VARCHAR(20),
    email VARCHAR(200),
    address TEXT,
    tax_number VARCHAR(50),
    balance DECIMAL(15,2) DEFAULT 0,
    notes TEXT,
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_suppliers_tenant ON suppliers(tenant_id);

-- =====================================================
-- 8. الفواتير (المبيعات)
-- =====================================================
CREATE TABLE IF NOT EXISTS invoices (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    branch_id UUID NOT NULL REFERENCES branches(id),
    user_id UUID REFERENCES users(id),
    invoice_number VARCHAR(50) NOT NULL,
    customer_id UUID REFERENCES customers(id),
    customer_name VARCHAR(300),
    subtotal DECIMAL(15,2) NOT NULL DEFAULT 0,
    discount_amount DECIMAL(15,2) DEFAULT 0,
    discount_percent DECIMAL(5,2) DEFAULT 0,
    tax_amount DECIMAL(15,2) DEFAULT 0,
    total DECIMAL(15,2) NOT NULL DEFAULT 0,
    paid DECIMAL(15,2) DEFAULT 0,
    remaining DECIMAL(15,2) DEFAULT 0,
    payment_type VARCHAR(20) DEFAULT 'cash',
    payment_details JSONB DEFAULT '{}'::jsonb,
    total_cost DECIMAL(15,2) DEFAULT 0,
    profit DECIMAL(15,2) DEFAULT 0,
    status VARCHAR(20) DEFAULT 'completed',
    notes TEXT,
    local_id VARCHAR(100),
    synced_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(tenant_id, invoice_number)
);

CREATE INDEX IF NOT EXISTS idx_invoices_tenant ON invoices(tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_invoices_branch ON invoices(branch_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_invoices_customer ON invoices(customer_id);
CREATE INDEX IF NOT EXISTS idx_invoices_date ON invoices(tenant_id, created_at);

-- =====================================================
-- 9. تفاصيل الفاتورة
-- =====================================================
CREATE TABLE IF NOT EXISTS invoice_items (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    invoice_id UUID NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
    product_id UUID REFERENCES products(id),
    product_name VARCHAR(300) NOT NULL,
    quantity DECIMAL(15,3) NOT NULL,
    unit_price DECIMAL(15,2) NOT NULL,
    unit_cost DECIMAL(15,2) DEFAULT 0,
    discount DECIMAL(15,2) DEFAULT 0,
    total DECIMAL(15,2) NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_invoice_items_invoice ON invoice_items(invoice_id);
CREATE INDEX IF NOT EXISTS idx_invoice_items_product ON invoice_items(product_id);

-- =====================================================
-- 10. المشتريات
-- =====================================================
CREATE TABLE IF NOT EXISTS purchases (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    branch_id UUID NOT NULL REFERENCES branches(id),
    supplier_id UUID REFERENCES suppliers(id),
    user_id UUID REFERENCES users(id),
    purchase_number VARCHAR(50) NOT NULL,
    supplier_name VARCHAR(300),
    subtotal DECIMAL(15,2) NOT NULL DEFAULT 0,
    discount_amount DECIMAL(15,2) DEFAULT 0,
    tax_amount DECIMAL(15,2) DEFAULT 0,
    total DECIMAL(15,2) NOT NULL DEFAULT 0,
    paid DECIMAL(15,2) DEFAULT 0,
    remaining DECIMAL(15,2) DEFAULT 0,
    payment_type VARCHAR(20) DEFAULT 'cash',
    notes TEXT,
    local_id VARCHAR(100),
    synced_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(tenant_id, purchase_number)
);

CREATE INDEX IF NOT EXISTS idx_purchases_tenant ON purchases(tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_purchases_supplier ON purchases(supplier_id);

-- =====================================================
-- 11. تفاصيل المشتريات
-- =====================================================
CREATE TABLE IF NOT EXISTS purchase_items (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    purchase_id UUID NOT NULL REFERENCES purchases(id) ON DELETE CASCADE,
    product_id UUID REFERENCES products(id),
    product_name VARCHAR(300) NOT NULL,
    quantity DECIMAL(15,3) NOT NULL,
    unit_cost DECIMAL(15,2) NOT NULL,
    total DECIMAL(15,2) NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- =====================================================
-- 12. المرتجعات
-- =====================================================
CREATE TABLE IF NOT EXISTS returns (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    branch_id UUID NOT NULL REFERENCES branches(id),
    user_id UUID REFERENCES users(id),
    return_number VARCHAR(50) NOT NULL,
    invoice_id UUID REFERENCES invoices(id),
    customer_id UUID REFERENCES customers(id),
    total_refund DECIMAL(15,2) NOT NULL DEFAULT 0,
    refund_method VARCHAR(20) DEFAULT 'cash',
    reason TEXT,
    local_id VARCHAR(100),
    synced_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(tenant_id, return_number)
);

CREATE INDEX IF NOT EXISTS idx_returns_tenant ON returns(tenant_id, created_at DESC);

-- =====================================================
-- 13. تفاصيل المرتجعات
-- =====================================================
CREATE TABLE IF NOT EXISTS return_items (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    return_id UUID NOT NULL REFERENCES returns(id) ON DELETE CASCADE,
    product_id UUID REFERENCES products(id),
    product_name VARCHAR(300) NOT NULL,
    quantity DECIMAL(15,3) NOT NULL,
    unit_price DECIMAL(15,2) NOT NULL,
    refund_amount DECIMAL(15,2) NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- =====================================================
-- 14. المصروفات
-- =====================================================
CREATE TABLE IF NOT EXISTS expenses (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    branch_id UUID NOT NULL REFERENCES branches(id),
    user_id UUID REFERENCES users(id),
    amount DECIMAL(15,2) NOT NULL,
    category VARCHAR(100) DEFAULT 'عام',
    description TEXT,
    expense_date DATE DEFAULT CURRENT_DATE,
    receipt_url TEXT,
    local_id VARCHAR(100),
    synced_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_expenses_tenant ON expenses(tenant_id, expense_date DESC);

-- =====================================================
-- 15. حركات المخزون
-- =====================================================
CREATE TABLE IF NOT EXISTS stock_movements (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    branch_id UUID NOT NULL REFERENCES branches(id),
    product_id UUID NOT NULL REFERENCES products(id),
    user_id UUID REFERENCES users(id),
    movement_type VARCHAR(30) NOT NULL,
    quantity DECIMAL(15,3) NOT NULL,
    stock_before DECIMAL(15,3),
    stock_after DECIMAL(15,3),
    reference_id UUID,
    reference_type VARCHAR(30),
    notes TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_stock_movements_tenant ON stock_movements(tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_stock_movements_product ON stock_movements(product_id, created_at DESC);

-- =====================================================
-- 16. حركات الخزينة
-- =====================================================
CREATE TABLE IF NOT EXISTS cash_transactions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    branch_id UUID NOT NULL REFERENCES branches(id),
    user_id UUID REFERENCES users(id),
    transaction_type VARCHAR(30) NOT NULL,
    amount DECIMAL(15,2) NOT NULL,
    balance_before DECIMAL(15,2),
    balance_after DECIMAL(15,2),
    reference_id UUID,
    reference_type VARCHAR(30),
    description TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_cash_tenant ON cash_transactions(tenant_id, created_at DESC);

-- =====================================================
-- 17. إعدادات كل عميل
-- =====================================================
CREATE TABLE IF NOT EXISTS tenant_settings (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    setting_key VARCHAR(100) NOT NULL,
    setting_value TEXT,
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(tenant_id, setting_key)
);

-- =====================================================
-- 18. سجل النشاطات
-- =====================================================
CREATE TABLE IF NOT EXISTS activity_log (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id UUID REFERENCES tenants(id) ON DELETE CASCADE,
    user_id UUID REFERENCES users(id),
    action VARCHAR(100) NOT NULL,
    entity_type VARCHAR(50),
    entity_id UUID,
    details JSONB DEFAULT '{}'::jsonb,
    ip_address VARCHAR(45),
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_activity_tenant ON activity_log(tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_activity_user ON activity_log(user_id, created_at DESC);

-- =====================================================
-- 19. المزامنة (للعمل بدون إنترنت)
-- =====================================================
CREATE TABLE IF NOT EXISTS sync_queue (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    branch_id UUID REFERENCES branches(id),
    device_id VARCHAR(100) NOT NULL,
    local_id VARCHAR(100) NOT NULL,
    operation VARCHAR(30) NOT NULL,
    entity_type VARCHAR(50) NOT NULL,
    payload JSONB NOT NULL,
    status VARCHAR(20) DEFAULT 'pending',
    error_message TEXT,
    retry_count INTEGER DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    synced_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_sync_tenant_status ON sync_queue(tenant_id, status);

-- =====================================================
-- Trigger لتحديث updated_at
-- =====================================================
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_tenants_updated ON tenants;
CREATE TRIGGER trg_tenants_updated BEFORE UPDATE ON tenants
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

DROP TRIGGER IF EXISTS trg_branches_updated ON branches;
CREATE TRIGGER trg_branches_updated BEFORE UPDATE ON branches
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

DROP TRIGGER IF EXISTS trg_users_updated ON users;
CREATE TRIGGER trg_users_updated BEFORE UPDATE ON users
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

DROP TRIGGER IF EXISTS trg_products_updated ON products;
CREATE TRIGGER trg_products_updated BEFORE UPDATE ON products
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

DROP TRIGGER IF EXISTS trg_customers_updated ON customers;
CREATE TRIGGER trg_customers_updated BEFORE UPDATE ON customers
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

DROP TRIGGER IF EXISTS trg_suppliers_updated ON suppliers;
CREATE TRIGGER trg_suppliers_updated BEFORE UPDATE ON suppliers
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- =====================================================
-- Views للتقارير السريعة
-- =====================================================
CREATE OR REPLACE VIEW v_low_stock AS
SELECT 
    p.*,
    t.business_name
FROM products p
JOIN tenants t ON t.id = p.tenant_id
WHERE p.is_service = FALSE 
  AND p.stock <= p.min_stock 
  AND p.is_active = TRUE
  AND t.is_active = TRUE;

-- =====================================================
-- نهاية المخطط ✅
-- =====================================================
