-- 008: الدفع الإلكتروني (MyPay): أسعار الباقات يحددها المالك، وطلبات دفع مرتبطة بالمتجر
CREATE TABLE IF NOT EXISTS plan_prices (
    plan VARCHAR(20) PRIMARY KEY,
    price NUMERIC(15,2) NOT NULL CHECK (price > 0),
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS payment_orders (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    plan VARCHAR(20) NOT NULL,
    amount NUMERIC(15,2) NOT NULL CHECK (amount > 0),
    currency VARCHAR(3) NOT NULL DEFAULT 'LYD',
    duration_minutes BIGINT NOT NULL CHECK (duration_minutes > 0),
    status VARCHAR(20) NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'paid', 'failed', 'mismatch')),
    mypay_token VARCHAR(120) UNIQUE,
    transaction_id VARCHAR(120) UNIQUE,      -- يمنع احتساب الإشعار نفسه مرتين
    trx_ref VARCHAR(120),
    gateway VARCHAR(60),
    created_by UUID REFERENCES users(id),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    paid_at TIMESTAMPTZ,
    last_event JSONB
);
CREATE INDEX IF NOT EXISTS idx_payment_orders_tenant ON payment_orders(tenant_id, created_at DESC);
