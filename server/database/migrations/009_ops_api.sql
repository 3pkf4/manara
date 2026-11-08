-- 009: سجل تدقيق لواجهة الدعم/الإدارة (Apps Script): من فعل ماذا ولمن
CREATE TABLE IF NOT EXISTS ops_audit (
    id BIGSERIAL PRIMARY KEY,
    actor VARCHAR(200) NOT NULL,
    action VARCHAR(60) NOT NULL,
    tenant_id UUID REFERENCES tenants(id) ON DELETE SET NULL,
    detail JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_ops_audit_time ON ops_audit(created_at DESC);
