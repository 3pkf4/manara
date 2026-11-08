BEGIN;

-- إضافة pgcrypto إذا لم تكن موجودة
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS system_setup (
    id INTEGER PRIMARY KEY DEFAULT 1,
    is_completed BOOLEAN DEFAULT FALSE,
    completed_at TIMESTAMPTZ,
    setup_token VARCHAR(64) NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    CONSTRAINT single_row CHECK (id = 1)
);

INSERT INTO system_setup (id, is_completed, setup_token)
VALUES (1, FALSE, encode(gen_random_bytes(32), 'hex'))
ON CONFLICT (id) DO NOTHING;

COMMIT;

