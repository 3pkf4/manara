BEGIN;

-- 1. جدول أجهزة الفروع
CREATE TABLE IF NOT EXISTS branch_devices (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    branch_id UUID NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
    device_id VARCHAR(100) NOT NULL,
    device_name VARCHAR(200),
    device_info JSONB DEFAULT '{}'::jsonb,
    is_active BOOLEAN DEFAULT TRUE,
    last_seen TIMESTAMPTZ DEFAULT NOW(),
    registered_by UUID REFERENCES users(id),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(tenant_id, device_id)
);

CREATE INDEX IF NOT EXISTS idx_devices_tenant ON branch_devices(tenant_id);
CREATE INDEX IF NOT EXISTS idx_devices_branch ON branch_devices(branch_id);
CREATE INDEX IF NOT EXISTS idx_devices_device_id ON branch_devices(device_id);

-- 2. أضف device_id لجلسات الدخول
ALTER TABLE sessions 
  ADD COLUMN IF NOT EXISTS device_id VARCHAR(100);

ALTER TABLE sessions 
  ADD COLUMN IF NOT EXISTS branch_id UUID REFERENCES branches(id);

-- 3. جدول محاولات الدخول
CREATE TABLE IF NOT EXISTS login_attempts (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    username VARCHAR(100) NOT NULL,
    device_id VARCHAR(100),
    ip_address VARCHAR(45),
    user_agent TEXT,
    success BOOLEAN DEFAULT FALSE,
    reason TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_login_attempts ON login_attempts(username, created_at DESC);

COMMIT;

-- التحقق
SELECT 
  'جدول devices: ' || COUNT(*) FROM information_schema.tables 
  WHERE table_name = 'branch_devices'
UNION ALL
SELECT 
  'عمود device_id في sessions: ' || COUNT(*) FROM information_schema.columns 
  WHERE table_name = 'sessions' AND column_name = 'device_id';
