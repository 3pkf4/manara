-- 006: باركودات متعددة، منتجات بالوزن (ميزان)، جرد، تحويلات بين الفروع
ALTER TABLE products ADD COLUMN IF NOT EXISTS plu VARCHAR(6);
ALTER TABLE products ADD COLUMN IF NOT EXISTS sold_by_weight BOOLEAN NOT NULL DEFAULT FALSE;
CREATE UNIQUE INDEX IF NOT EXISTS uq_products_plu ON products(tenant_id, branch_id, plu) WHERE plu IS NOT NULL AND is_active;
CREATE INDEX IF NOT EXISTS idx_products_barcode ON products(tenant_id, barcode) WHERE barcode IS NOT NULL;

-- باركودات إضافية للمنتج الواحد (مثلاً باركود الكرتونة = 12 حبة)
CREATE TABLE IF NOT EXISTS product_barcodes (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    branch_id UUID NOT NULL REFERENCES branches(id),
    product_id UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    barcode VARCHAR(100) NOT NULL,
    pack_qty NUMERIC(15,3) NOT NULL DEFAULT 1 CHECK (pack_qty > 0),
    label VARCHAR(100),
    created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_product_barcodes ON product_barcodes(tenant_id, branch_id, barcode);
CREATE INDEX IF NOT EXISTS idx_product_barcodes_product ON product_barcodes(product_id);

-- الجرد
CREATE TABLE IF NOT EXISTS stocktakes (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    branch_id UUID NOT NULL REFERENCES branches(id),
    number VARCHAR(40) NOT NULL,
    name VARCHAR(200),
    status VARCHAR(20) NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed','cancelled')),
    notes TEXT,
    created_by UUID REFERENCES users(id),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    closed_by UUID REFERENCES users(id),
    closed_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_stocktakes_tenant ON stocktakes(tenant_id, created_at DESC);

CREATE TABLE IF NOT EXISTS stocktake_items (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    stocktake_id UUID NOT NULL REFERENCES stocktakes(id) ON DELETE CASCADE,
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    product_id UUID NOT NULL REFERENCES products(id),
    expected NUMERIC(15,3) NOT NULL,
    counted NUMERIC(15,3) NOT NULL CHECK (counted >= 0),
    counted_by UUID REFERENCES users(id),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (stocktake_id, product_id)
);

-- تحويل مخزون بين الفروع
CREATE TABLE IF NOT EXISTS stock_transfers (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    number VARCHAR(40) NOT NULL,
    from_branch_id UUID NOT NULL REFERENCES branches(id),
    to_branch_id UUID NOT NULL REFERENCES branches(id),
    notes TEXT,
    created_by UUID REFERENCES users(id),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    CHECK (from_branch_id <> to_branch_id)
);
CREATE INDEX IF NOT EXISTS idx_stock_transfers_tenant ON stock_transfers(tenant_id, created_at DESC);

CREATE TABLE IF NOT EXISTS stock_transfer_items (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    transfer_id UUID NOT NULL REFERENCES stock_transfers(id) ON DELETE CASCADE,
    from_product_id UUID NOT NULL REFERENCES products(id),
    to_product_id UUID NOT NULL REFERENCES products(id),
    quantity NUMERIC(15,3) NOT NULL CHECK (quantity > 0),
    unit_cost NUMERIC(15,2) NOT NULL DEFAULT 0
);
