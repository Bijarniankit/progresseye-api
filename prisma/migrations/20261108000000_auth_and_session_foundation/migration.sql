-- Phase 12a Migration: Auth & Session Foundation

-- 1. AlterTable users
ALTER TABLE "users"
  ADD COLUMN IF NOT EXISTS "must_change_password" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "failed_login_attempts" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "locked_until" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "last_login_at" TIMESTAMP(3);

-- 2. AlterTable sessions
ALTER TABLE "sessions"
  ADD COLUMN IF NOT EXISTS "family_id" UUID NOT NULL DEFAULT gen_random_uuid(),
  ADD COLUMN IF NOT EXISTS "parent_token_hash" TEXT,
  ADD COLUMN IF NOT EXISTS "client_type" TEXT NOT NULL DEFAULT 'web';

-- 3. Constraints & Indices
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'check_sessions_family_id_not_nil'
    ) THEN
        ALTER TABLE "sessions" ADD CONSTRAINT "check_sessions_family_id_not_nil" CHECK ("family_id" <> '00000000-0000-0000-0000-000000000000'::uuid);
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS "sessions_school_id_family_id_idx" ON "sessions"("school_id", "family_id");
