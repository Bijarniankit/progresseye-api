-- Phase 12b-2 Migration: Two-Factor Authentication (TOTP) and Recovery Codes

-- 1. Alter users table to track two-factor authentication enablement status
ALTER TABLE "users"
  ADD COLUMN IF NOT EXISTS "is_two_factor_enabled" BOOLEAN NOT NULL DEFAULT false;

-- 2. Create user_two_factor_secrets table
CREATE TABLE IF NOT EXISTS "user_two_factor_secrets" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "school_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "encrypted_secret" TEXT NOT NULL,
    "iv" TEXT NOT NULL,
    "auth_tag" TEXT NOT NULL,
    "is_verified" BOOLEAN NOT NULL DEFAULT false,
    "verified_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_two_factor_secrets_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "user_two_factor_secrets_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "schools"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "user_two_factor_secrets_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- Nil-UUID check for user_two_factor_secrets
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'check_user_two_factor_secrets_school_id_not_nil'
    ) THEN
        ALTER TABLE "user_two_factor_secrets" ADD CONSTRAINT "check_user_two_factor_secrets_school_id_not_nil" CHECK ("school_id" <> '00000000-0000-0000-0000-000000000000'::uuid);
    END IF;
END $$;

-- Indices for user_two_factor_secrets
CREATE UNIQUE INDEX IF NOT EXISTS "user_two_factor_secrets_user_id_key" ON "user_two_factor_secrets"("user_id");
CREATE INDEX IF NOT EXISTS "user_two_factor_secrets_school_id_user_id_idx" ON "user_two_factor_secrets"("school_id", "user_id");

-- RLS for user_two_factor_secrets
ALTER TABLE "user_two_factor_secrets" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "user_two_factor_secrets" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "user_two_factor_secrets_tenant_isolation" ON "user_two_factor_secrets";
CREATE POLICY "user_two_factor_secrets_tenant_isolation" ON "user_two_factor_secrets"
    FOR ALL
    USING (school_id = COALESCE(NULLIF(current_setting('app.current_school_id', true), ''), '00000000-0000-0000-0000-000000000000')::uuid)
    WITH CHECK (school_id = COALESCE(NULLIF(current_setting('app.current_school_id', true), ''), '00000000-0000-0000-0000-000000000000')::uuid);

-- 3. Create user_recovery_codes table
CREATE TABLE IF NOT EXISTS "user_recovery_codes" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "school_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "code_hash" TEXT NOT NULL,
    "used_at" TIMESTAMP(3),
    "revoked_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_recovery_codes_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "user_recovery_codes_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "schools"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "user_recovery_codes_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- Nil-UUID check for user_recovery_codes
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'check_user_recovery_codes_school_id_not_nil'
    ) THEN
        ALTER TABLE "user_recovery_codes" ADD CONSTRAINT "check_user_recovery_codes_school_id_not_nil" CHECK ("school_id" <> '00000000-0000-0000-0000-000000000000'::uuid);
    END IF;
END $$;

-- Indices for user_recovery_codes
CREATE UNIQUE INDEX IF NOT EXISTS "user_recovery_codes_user_id_code_hash_key" ON "user_recovery_codes"("user_id", "code_hash");
CREATE INDEX IF NOT EXISTS "user_recovery_codes_school_id_user_id_idx" ON "user_recovery_codes"("school_id", "user_id");

-- RLS for user_recovery_codes
ALTER TABLE "user_recovery_codes" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "user_recovery_codes" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "user_recovery_codes_tenant_isolation" ON "user_recovery_codes";
CREATE POLICY "user_recovery_codes_tenant_isolation" ON "user_recovery_codes"
    FOR ALL
    USING (school_id = COALESCE(NULLIF(current_setting('app.current_school_id', true), ''), '00000000-0000-0000-0000-000000000000')::uuid)
    WITH CHECK (school_id = COALESCE(NULLIF(current_setting('app.current_school_id', true), ''), '00000000-0000-0000-0000-000000000000')::uuid);

-- 4. Role Ownership and Minimal Grants
ALTER TABLE "user_two_factor_secrets" OWNER TO progresseye_owner;
ALTER TABLE "user_recovery_codes" OWNER TO progresseye_owner;

GRANT SELECT, INSERT, UPDATE ON "user_two_factor_secrets" TO progresseye_app;
GRANT SELECT, INSERT, UPDATE ON "user_recovery_codes" TO progresseye_app;

GRANT SELECT ON "user_two_factor_secrets" TO progresseye_ro;
GRANT SELECT ON "user_recovery_codes" TO progresseye_ro;
