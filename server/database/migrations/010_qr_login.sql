-- 010: دخول جهاز الكاشير بمسح QR (رمز لمرة واحدة، قصير العمر، يُخزَّن مجزّأً)
CREATE TABLE IF NOT EXISTS device_login_tokens (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash CHAR(64) NOT NULL UNIQUE,
    expires_at TIMESTAMPTZ NOT NULL,
    used_at TIMESTAMPTZ,
    created_by UUID REFERENCES users(id),
    created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_dlt_tenant ON device_login_tokens(tenant_id, created_at DESC);
