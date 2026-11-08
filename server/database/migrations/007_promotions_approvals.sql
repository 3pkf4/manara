-- 007: عروض تلقائية (نسبة أو سعر ثابت) + اعتماد المدير لتجاوز حدود الكاشير
CREATE TABLE IF NOT EXISTS promotions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    branch_id UUID REFERENCES branches(id),              -- NULL = كل الفروع
    name VARCHAR(200) NOT NULL,
    kind VARCHAR(20) NOT NULL CHECK (kind IN ('percent', 'fixed_price')),
    value NUMERIC(15,2) NOT NULL CHECK (value > 0),
    product_id UUID REFERENCES products(id) ON DELETE CASCADE,
    category VARCHAR(100),
    starts_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    ends_at TIMESTAMPTZ,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_by UUID REFERENCES users(id),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    CHECK (product_id IS NOT NULL OR category IS NOT NULL),
    CHECK (kind <> 'percent' OR value <= 100),
    CHECK (ends_at IS NULL OR ends_at > starts_at)
);
CREATE INDEX IF NOT EXISTS idx_promotions_tenant ON promotions(tenant_id, is_active);

ALTER TABLE invoices ADD COLUMN IF NOT EXISTS approved_by UUID REFERENCES users(id);
