-- Phase 12b-1 Migration: Account Lifecycle, Password Reset, and Email Verification Tokens

-- 1. Alter users table to track email verification timestamp
ALTER TABLE "users"
  ADD COLUMN IF NOT EXISTS "email_verified_at" TIMESTAMP(3);

-- 2. Create password_reset_tokens table
CREATE TABLE IF NOT EXISTS "password_reset_tokens" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "school_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "used_at" TIMESTAMP(3),
    "ip_address" TEXT,
    "user_agent" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "password_reset_tokens_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "password_reset_tokens_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "schools"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "password_reset_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- Nil-UUID check for password_reset_tokens
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'check_password_reset_tokens_school_id_not_nil'
    ) THEN
        ALTER TABLE "password_reset_tokens" ADD CONSTRAINT "check_password_reset_tokens_school_id_not_nil" CHECK ("school_id" <> '00000000-0000-0000-0000-000000000000'::uuid);
    END IF;
END $$;

-- Indices for password_reset_tokens
CREATE UNIQUE INDEX IF NOT EXISTS "password_reset_tokens_token_hash_key" ON "password_reset_tokens"("token_hash");
CREATE INDEX IF NOT EXISTS "password_reset_tokens_school_id_user_id_idx" ON "password_reset_tokens"("school_id", "user_id");

-- RLS for password_reset_tokens
ALTER TABLE "password_reset_tokens" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "password_reset_tokens" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "password_reset_tokens_tenant_isolation" ON "password_reset_tokens";
CREATE POLICY "password_reset_tokens_tenant_isolation" ON "password_reset_tokens"
    FOR ALL
    USING (school_id = COALESCE(NULLIF(current_setting('app.current_school_id', true), ''), '00000000-0000-0000-0000-000000000000')::uuid)
    WITH CHECK (school_id = COALESCE(NULLIF(current_setting('app.current_school_id', true), ''), '00000000-0000-0000-0000-000000000000')::uuid);

-- 3. Create email_verification_tokens table
CREATE TABLE IF NOT EXISTS "email_verification_tokens" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "school_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "used_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "email_verification_tokens_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "email_verification_tokens_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "schools"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "email_verification_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- Nil-UUID check for email_verification_tokens
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'check_email_verification_tokens_school_id_not_nil'
    ) THEN
        ALTER TABLE "email_verification_tokens" ADD CONSTRAINT "check_email_verification_tokens_school_id_not_nil" CHECK ("school_id" <> '00000000-0000-0000-0000-000000000000'::uuid);
    END IF;
END $$;

-- Indices for email_verification_tokens
CREATE UNIQUE INDEX IF NOT EXISTS "email_verification_tokens_token_hash_key" ON "email_verification_tokens"("token_hash");
CREATE INDEX IF NOT EXISTS "email_verification_tokens_school_id_user_id_idx" ON "email_verification_tokens"("school_id", "user_id");

-- RLS for email_verification_tokens
ALTER TABLE "email_verification_tokens" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "email_verification_tokens" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "email_verification_tokens_tenant_isolation" ON "email_verification_tokens";
CREATE POLICY "email_verification_tokens_tenant_isolation" ON "email_verification_tokens"
    FOR ALL
    USING (school_id = COALESCE(NULLIF(current_setting('app.current_school_id', true), ''), '00000000-0000-0000-0000-000000000000')::uuid)
    WITH CHECK (school_id = COALESCE(NULLIF(current_setting('app.current_school_id', true), ''), '00000000-0000-0000-0000-000000000000')::uuid);

-- 4. Role Ownership and Minimal Grants
ALTER TABLE "password_reset_tokens" OWNER TO progresseye_owner;
ALTER TABLE "email_verification_tokens" OWNER TO progresseye_owner;

GRANT SELECT, INSERT, UPDATE, DELETE ON "password_reset_tokens" TO progresseye_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON "email_verification_tokens" TO progresseye_app;

GRANT SELECT ON "password_reset_tokens" TO progresseye_ro;
GRANT SELECT ON "email_verification_tokens" TO progresseye_ro;
