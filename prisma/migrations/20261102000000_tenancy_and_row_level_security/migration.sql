-- ProgressEye Multi-Tenancy & Row-Level Security (RLS) Foundation
-- PostgreSQL 17 Forward-Only Migration

-- -------------------------------------------------------------
-- 1. Database Roles Provisioning
-- -------------------------------------------------------------
DO $$
BEGIN
    -- Application role: runs the API server, strictly NOBYPASSRLS
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'progresseye_app') THEN
        CREATE ROLE progresseye_app WITH LOGIN PASSWORD 'apppassword' NOBYPASSRLS NOSUPERUSER NOCREATEDB NOCREATEROLE;
    ELSE
        ALTER ROLE progresseye_app WITH LOGIN PASSWORD 'apppassword' NOBYPASSRLS NOSUPERUSER NOCREATEDB NOCREATEROLE;
    END IF;

    -- Read-only role: for MCP inspection, telemetry, and analytics, strictly NOBYPASSRLS
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'progresseye_ro') THEN
        CREATE ROLE progresseye_ro WITH LOGIN PASSWORD 'ropassword' NOBYPASSRLS NOSUPERUSER NOCREATEDB NOCREATEROLE;
    ELSE
        ALTER ROLE progresseye_ro WITH LOGIN PASSWORD 'ropassword' NOBYPASSRLS NOSUPERUSER NOCREATEDB NOCREATEROLE;
    END IF;

    -- Owner role: runs migrations, maintains DDL schema, strictly NOBYPASSRLS
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'progresseye_owner') THEN
        CREATE ROLE progresseye_owner WITH LOGIN PASSWORD 'ownerpassword' NOBYPASSRLS NOSUPERUSER NOCREATEDB NOCREATEROLE;
    ELSE
        ALTER ROLE progresseye_owner WITH LOGIN PASSWORD 'ownerpassword' NOBYPASSRLS NOSUPERUSER NOCREATEDB NOCREATEROLE;
    END IF;

    EXECUTE format('GRANT CONNECT ON DATABASE %I TO progresseye_owner, progresseye_app, progresseye_ro', current_database());
END $$;

-- -------------------------------------------------------------
-- 2. Organizations Table (Multi-Tenant Root)
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "organizations" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "organizations_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "check_organizations_not_nil_uuid" CHECK ("id" <> '00000000-0000-0000-0000-000000000000'::uuid)
);

CREATE UNIQUE INDEX IF NOT EXISTS "organizations_slug_key" ON "organizations"("slug") WHERE "deleted_at" IS NULL;

-- -------------------------------------------------------------
-- 3. Schools Table (Tenant Root Alterations)
-- -------------------------------------------------------------
ALTER TABLE "schools" ADD COLUMN IF NOT EXISTS "organization_id" UUID;
ALTER TABLE "schools" ADD COLUMN IF NOT EXISTS "is_active" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "schools" ADD COLUMN IF NOT EXISTS "deleted_at" TIMESTAMP(3);
ALTER TABLE "schools" ALTER COLUMN "updated_at" SET DEFAULT CURRENT_TIMESTAMP;

-- Replace unconditional unique index with partial unique index WHERE deleted_at IS NULL
DROP INDEX IF EXISTS "schools_slug_key";
CREATE UNIQUE INDEX IF NOT EXISTS "schools_slug_key" ON "schools"("slug") WHERE "deleted_at" IS NULL;

-- Ensure Nil-UUID cannot exist as a school ID
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'check_schools_not_nil_uuid'
    ) THEN
        ALTER TABLE "schools" ADD CONSTRAINT "check_schools_not_nil_uuid" CHECK ("id" <> '00000000-0000-0000-0000-000000000000'::uuid);
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'schools_organization_id_fkey'
    ) THEN
        ALTER TABLE "schools" ADD CONSTRAINT "schools_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE SET NULL ON UPDATE CASCADE;
    END IF;
END $$;

-- -------------------------------------------------------------
-- 4. Academic Years (Tenant Scoped)
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "academic_years" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "school_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "start_date" DATE NOT NULL,
    "end_date" DATE NOT NULL,
    "is_current" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "academic_years_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "check_academic_years_not_nil_uuid" CHECK ("id" <> '00000000-0000-0000-0000-000000000000'::uuid),
    CONSTRAINT "check_academic_years_school_not_nil_uuid" CHECK ("school_id" <> '00000000-0000-0000-0000-000000000000'::uuid),
    CONSTRAINT "academic_years_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "schools"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "academic_years_school_id_name_key" ON "academic_years"("school_id", "name") WHERE "deleted_at" IS NULL;
CREATE INDEX IF NOT EXISTS "academic_years_school_id_idx" ON "academic_years"("school_id");

-- -------------------------------------------------------------
-- 5. Users (Tenant Scoped)
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "users" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "school_id" UUID NOT NULL,
    "email" citext NOT NULL,
    "phone" TEXT,
    "password_hash" TEXT,
    "first_name" TEXT NOT NULL,
    "last_name" TEXT NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "users_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "check_users_not_nil_uuid" CHECK ("id" <> '00000000-0000-0000-0000-000000000000'::uuid),
    CONSTRAINT "check_users_school_not_nil_uuid" CHECK ("school_id" <> '00000000-0000-0000-0000-000000000000'::uuid),
    CONSTRAINT "users_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "schools"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "users_school_id_email_key" ON "users"("school_id", "email") WHERE "deleted_at" IS NULL;
CREATE INDEX IF NOT EXISTS "users_school_id_idx" ON "users"("school_id");

-- -------------------------------------------------------------
-- 6. Sessions (Tenant Scoped, Immutable/Revocable)
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "sessions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "school_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "user_agent" TEXT,
    "ip_address" TEXT,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "revoked_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "check_sessions_not_nil_uuid" CHECK ("id" <> '00000000-0000-0000-0000-000000000000'::uuid),
    CONSTRAINT "check_sessions_school_not_nil_uuid" CHECK ("school_id" <> '00000000-0000-0000-0000-000000000000'::uuid),
    CONSTRAINT "sessions_token_hash_key" UNIQUE ("token_hash"),
    CONSTRAINT "sessions_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "schools"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "sessions_school_id_user_id_idx" ON "sessions"("school_id", "user_id");

-- -------------------------------------------------------------
-- 7. Roles (Tenant Scoped)
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "roles" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "school_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "description" TEXT,
    "is_system" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "roles_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "check_roles_not_nil_uuid" CHECK ("id" <> '00000000-0000-0000-0000-000000000000'::uuid),
    CONSTRAINT "check_roles_school_not_nil_uuid" CHECK ("school_id" <> '00000000-0000-0000-0000-000000000000'::uuid),
    CONSTRAINT "roles_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "schools"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "roles_school_id_slug_key" ON "roles"("school_id", "slug") WHERE "deleted_at" IS NULL;
CREATE INDEX IF NOT EXISTS "roles_school_id_idx" ON "roles"("school_id");

-- -------------------------------------------------------------
-- 8. Permissions (Global Catalog)
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "permissions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "code" TEXT NOT NULL,
    "module" TEXT NOT NULL,
    "description" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "permissions_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "check_permissions_not_nil_uuid" CHECK ("id" <> '00000000-0000-0000-0000-000000000000'::uuid),
    CONSTRAINT "permissions_code_key" UNIQUE ("code")
);

-- -------------------------------------------------------------
-- 9. Role Permissions (Tenant Scoped Junction)
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "role_permissions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "school_id" UUID NOT NULL,
    "role_id" UUID NOT NULL,
    "permission_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "role_permissions_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "check_role_permissions_not_nil_uuid" CHECK ("id" <> '00000000-0000-0000-0000-000000000000'::uuid),
    CONSTRAINT "check_role_permissions_school_not_nil_uuid" CHECK ("school_id" <> '00000000-0000-0000-0000-000000000000'::uuid),
    CONSTRAINT "role_permissions_school_id_role_id_permission_id_key" UNIQUE ("school_id", "role_id", "permission_id"),
    CONSTRAINT "role_permissions_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "schools"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "role_permissions_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "roles"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "role_permissions_permission_id_fkey" FOREIGN KEY ("permission_id") REFERENCES "permissions"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- -------------------------------------------------------------
-- 10. User Roles (Tenant Scoped Junction)
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "user_roles" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "school_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "role_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_roles_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "check_user_roles_not_nil_uuid" CHECK ("id" <> '00000000-0000-0000-0000-000000000000'::uuid),
    CONSTRAINT "check_user_roles_school_not_nil_uuid" CHECK ("school_id" <> '00000000-0000-0000-0000-000000000000'::uuid),
    CONSTRAINT "user_roles_school_id_user_id_role_id_key" UNIQUE ("school_id", "user_id", "role_id"),
    CONSTRAINT "user_roles_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "schools"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "user_roles_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "user_roles_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "roles"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- -------------------------------------------------------------
-- 11. Audit Logs (Tenant Scoped, Partitioned by Month)
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "audit_logs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "school_id" UUID NOT NULL,
    "user_id" UUID,
    "action" TEXT NOT NULL,
    "resource" TEXT NOT NULL,
    "resource_id" TEXT,
    "ip_address" TEXT,
    "user_agent" TEXT,
    "payload" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id", "created_at"),
    CONSTRAINT "check_audit_logs_not_nil_uuid" CHECK ("id" <> '00000000-0000-0000-0000-000000000000'::uuid),
    CONSTRAINT "check_audit_logs_school_not_nil_uuid" CHECK ("school_id" <> '00000000-0000-0000-0000-000000000000'::uuid)
) PARTITION BY RANGE ("created_at");

CREATE INDEX IF NOT EXISTS "audit_logs_school_id_created_at_idx" ON "audit_logs"("school_id", "created_at");

-- Pre-provision child monthly partitions
CREATE TABLE IF NOT EXISTS "audit_logs_y2026m10" PARTITION OF "audit_logs"
    FOR VALUES FROM ('2026-10-01 00:00:00') TO ('2026-11-01 00:00:00');

CREATE TABLE IF NOT EXISTS "audit_logs_y2026m11" PARTITION OF "audit_logs"
    FOR VALUES FROM ('2026-11-01 00:00:00') TO ('2026-12-01 00:00:00');

CREATE TABLE IF NOT EXISTS "audit_logs_y2026m12" PARTITION OF "audit_logs"
    FOR VALUES FROM ('2026-12-01 00:00:00') TO ('2027-01-01 00:00:00');

CREATE TABLE IF NOT EXISTS "audit_logs_y2027m01" PARTITION OF "audit_logs"
    FOR VALUES FROM ('2027-01-01 00:00:00') TO ('2027-02-01 00:00:00');

CREATE TABLE IF NOT EXISTS "audit_logs_default" PARTITION OF "audit_logs" DEFAULT;

-- -------------------------------------------------------------
-- 12. Outbox Events (Tenant Scoped)
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "outbox_events" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "school_id" UUID NOT NULL,
    "event_type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "retry_count" INTEGER NOT NULL DEFAULT 0,
    "processed_at" TIMESTAMP(3),
    "error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "outbox_events_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "check_outbox_events_not_nil_uuid" CHECK ("id" <> '00000000-0000-0000-0000-000000000000'::uuid),
    CONSTRAINT "check_outbox_events_school_not_nil_uuid" CHECK ("school_id" <> '00000000-0000-0000-0000-000000000000'::uuid),
    CONSTRAINT "outbox_events_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "schools"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "outbox_events_school_id_status_idx" ON "outbox_events"("school_id", "status");

-- -------------------------------------------------------------
-- 13. Counters (Tenant Scoped, Concurrency Sequences)
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "counters" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "school_id" UUID NOT NULL,
    "academic_year_id" UUID,
    "sequence_name" TEXT NOT NULL,
    "current_value" BIGINT NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "counters_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "check_counters_not_nil_uuid" CHECK ("id" <> '00000000-0000-0000-0000-000000000000'::uuid),
    CONSTRAINT "check_counters_school_not_nil_uuid" CHECK ("school_id" <> '00000000-0000-0000-0000-000000000000'::uuid),
    CONSTRAINT "counters_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "schools"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "counters_academic_year_id_fkey" FOREIGN KEY ("academic_year_id") REFERENCES "academic_years"("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "counters_school_seq_year_key" ON "counters"("school_id", "sequence_name", (COALESCE("academic_year_id", '00000000-0000-0000-0000-000000000000'::uuid)));
CREATE INDEX IF NOT EXISTS "counters_school_id_sequence_name_idx" ON "counters"("school_id", "sequence_name");

-- -------------------------------------------------------------
-- 14. Row-Level Security (RLS) Policies & Enforcement
-- -------------------------------------------------------------

-- Helper macro behavior:
-- Fail-closed condition evaluates to:
-- school_id = COALESCE(NULLIF(current_setting('app.current_school_id', true), ''), '00000000-0000-0000-0000-000000000000')::uuid

-- A. Schools Table
ALTER TABLE "schools" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "schools" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "schools_tenant_isolation" ON "schools";
CREATE POLICY "schools_tenant_isolation" ON "schools"
    FOR ALL
    USING (
        id = COALESCE(NULLIF(current_setting('app.current_school_id', true), ''), '00000000-0000-0000-0000-000000000000')::uuid
        OR (current_setting('app.current_school_id', true) IS NULL AND is_active = true)
        OR (current_setting('app.current_school_id', true) = '' AND is_active = true)
    )
    WITH CHECK (
        id = COALESCE(NULLIF(current_setting('app.current_school_id', true), ''), '00000000-0000-0000-0000-000000000000')::uuid
    );

-- B. Academic Years
ALTER TABLE "academic_years" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "academic_years" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "academic_years_tenant_isolation" ON "academic_years";
CREATE POLICY "academic_years_tenant_isolation" ON "academic_years"
    FOR ALL
    USING (school_id = COALESCE(NULLIF(current_setting('app.current_school_id', true), ''), '00000000-0000-0000-0000-000000000000')::uuid)
    WITH CHECK (school_id = COALESCE(NULLIF(current_setting('app.current_school_id', true), ''), '00000000-0000-0000-0000-000000000000')::uuid);

-- C. Users
ALTER TABLE "users" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "users" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "users_tenant_isolation" ON "users";
CREATE POLICY "users_tenant_isolation" ON "users"
    FOR ALL
    USING (school_id = COALESCE(NULLIF(current_setting('app.current_school_id', true), ''), '00000000-0000-0000-0000-000000000000')::uuid)
    WITH CHECK (school_id = COALESCE(NULLIF(current_setting('app.current_school_id', true), ''), '00000000-0000-0000-0000-000000000000')::uuid);

-- D. Sessions
ALTER TABLE "sessions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "sessions" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "sessions_tenant_isolation" ON "sessions";
CREATE POLICY "sessions_tenant_isolation" ON "sessions"
    FOR ALL
    USING (school_id = COALESCE(NULLIF(current_setting('app.current_school_id', true), ''), '00000000-0000-0000-0000-000000000000')::uuid)
    WITH CHECK (school_id = COALESCE(NULLIF(current_setting('app.current_school_id', true), ''), '00000000-0000-0000-0000-000000000000')::uuid);

-- E. Roles
ALTER TABLE "roles" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "roles" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "roles_tenant_isolation" ON "roles";
CREATE POLICY "roles_tenant_isolation" ON "roles"
    FOR ALL
    USING (school_id = COALESCE(NULLIF(current_setting('app.current_school_id', true), ''), '00000000-0000-0000-0000-000000000000')::uuid)
    WITH CHECK (school_id = COALESCE(NULLIF(current_setting('app.current_school_id', true), ''), '00000000-0000-0000-0000-000000000000')::uuid);

-- F. Role Permissions
ALTER TABLE "role_permissions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "role_permissions" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "role_permissions_tenant_isolation" ON "role_permissions";
CREATE POLICY "role_permissions_tenant_isolation" ON "role_permissions"
    FOR ALL
    USING (school_id = COALESCE(NULLIF(current_setting('app.current_school_id', true), ''), '00000000-0000-0000-0000-000000000000')::uuid)
    WITH CHECK (school_id = COALESCE(NULLIF(current_setting('app.current_school_id', true), ''), '00000000-0000-0000-0000-000000000000')::uuid);

-- G. User Roles
ALTER TABLE "user_roles" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "user_roles" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "user_roles_tenant_isolation" ON "user_roles";
CREATE POLICY "user_roles_tenant_isolation" ON "user_roles"
    FOR ALL
    USING (school_id = COALESCE(NULLIF(current_setting('app.current_school_id', true), ''), '00000000-0000-0000-0000-000000000000')::uuid)
    WITH CHECK (school_id = COALESCE(NULLIF(current_setting('app.current_school_id', true), ''), '00000000-0000-0000-0000-000000000000')::uuid);

-- H. Audit Logs (Parent & All Partitions)
ALTER TABLE "audit_logs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "audit_logs" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "audit_logs_tenant_isolation" ON "audit_logs";
CREATE POLICY "audit_logs_tenant_isolation" ON "audit_logs"
    FOR ALL
    USING (school_id = COALESCE(NULLIF(current_setting('app.current_school_id', true), ''), '00000000-0000-0000-0000-000000000000')::uuid)
    WITH CHECK (school_id = COALESCE(NULLIF(current_setting('app.current_school_id', true), ''), '00000000-0000-0000-0000-000000000000')::uuid);

ALTER TABLE "audit_logs_y2026m10" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "audit_logs_y2026m10" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "audit_logs_y2026m10_tenant_isolation" ON "audit_logs_y2026m10";
CREATE POLICY "audit_logs_y2026m10_tenant_isolation" ON "audit_logs_y2026m10"
    FOR ALL
    USING (school_id = COALESCE(NULLIF(current_setting('app.current_school_id', true), ''), '00000000-0000-0000-0000-000000000000')::uuid)
    WITH CHECK (school_id = COALESCE(NULLIF(current_setting('app.current_school_id', true), ''), '00000000-0000-0000-0000-000000000000')::uuid);

ALTER TABLE "audit_logs_y2026m11" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "audit_logs_y2026m11" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "audit_logs_y2026m11_tenant_isolation" ON "audit_logs_y2026m11";
CREATE POLICY "audit_logs_y2026m11_tenant_isolation" ON "audit_logs_y2026m11"
    FOR ALL
    USING (school_id = COALESCE(NULLIF(current_setting('app.current_school_id', true), ''), '00000000-0000-0000-0000-000000000000')::uuid)
    WITH CHECK (school_id = COALESCE(NULLIF(current_setting('app.current_school_id', true), ''), '00000000-0000-0000-0000-000000000000')::uuid);

ALTER TABLE "audit_logs_y2026m12" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "audit_logs_y2026m12" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "audit_logs_y2026m12_tenant_isolation" ON "audit_logs_y2026m12";
CREATE POLICY "audit_logs_y2026m12_tenant_isolation" ON "audit_logs_y2026m12"
    FOR ALL
    USING (school_id = COALESCE(NULLIF(current_setting('app.current_school_id', true), ''), '00000000-0000-0000-0000-000000000000')::uuid)
    WITH CHECK (school_id = COALESCE(NULLIF(current_setting('app.current_school_id', true), ''), '00000000-0000-0000-0000-000000000000')::uuid);

ALTER TABLE "audit_logs_y2027m01" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "audit_logs_y2027m01" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "audit_logs_y2027m01_tenant_isolation" ON "audit_logs_y2027m01";
CREATE POLICY "audit_logs_y2027m01_tenant_isolation" ON "audit_logs_y2027m01"
    FOR ALL
    USING (school_id = COALESCE(NULLIF(current_setting('app.current_school_id', true), ''), '00000000-0000-0000-0000-000000000000')::uuid)
    WITH CHECK (school_id = COALESCE(NULLIF(current_setting('app.current_school_id', true), ''), '00000000-0000-0000-0000-000000000000')::uuid);

ALTER TABLE "audit_logs_default" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "audit_logs_default" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "audit_logs_default_tenant_isolation" ON "audit_logs_default";
CREATE POLICY "audit_logs_default_tenant_isolation" ON "audit_logs_default"
    FOR ALL
    USING (school_id = COALESCE(NULLIF(current_setting('app.current_school_id', true), ''), '00000000-0000-0000-0000-000000000000')::uuid)
    WITH CHECK (school_id = COALESCE(NULLIF(current_setting('app.current_school_id', true), ''), '00000000-0000-0000-0000-000000000000')::uuid);

-- I. Outbox Events
ALTER TABLE "outbox_events" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "outbox_events" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "outbox_events_tenant_isolation" ON "outbox_events";
CREATE POLICY "outbox_events_tenant_isolation" ON "outbox_events"
    FOR ALL
    USING (school_id = COALESCE(NULLIF(current_setting('app.current_school_id', true), ''), '00000000-0000-0000-0000-000000000000')::uuid)
    WITH CHECK (school_id = COALESCE(NULLIF(current_setting('app.current_school_id', true), ''), '00000000-0000-0000-0000-000000000000')::uuid);

-- J. Counters
ALTER TABLE "counters" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "counters" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "counters_tenant_isolation" ON "counters";
CREATE POLICY "counters_tenant_isolation" ON "counters"
    FOR ALL
    USING (school_id = COALESCE(NULLIF(current_setting('app.current_school_id', true), ''), '00000000-0000-0000-0000-000000000000')::uuid)
    WITH CHECK (school_id = COALESCE(NULLIF(current_setting('app.current_school_id', true), ''), '00000000-0000-0000-0000-000000000000')::uuid);

-- -------------------------------------------------------------
-- 15. Role Grants & Permissions Enforcement
-- -------------------------------------------------------------
-- Grant schema usage
GRANT USAGE, CREATE ON SCHEMA public TO progresseye_owner;
GRANT USAGE ON SCHEMA public TO progresseye_app, progresseye_ro;

-- Transfer table ownership to progresseye_owner
ALTER TABLE "organizations" OWNER TO progresseye_owner;
ALTER TABLE "schools" OWNER TO progresseye_owner;
ALTER TABLE "academic_years" OWNER TO progresseye_owner;
ALTER TABLE "users" OWNER TO progresseye_owner;
ALTER TABLE "sessions" OWNER TO progresseye_owner;
ALTER TABLE "roles" OWNER TO progresseye_owner;
ALTER TABLE "permissions" OWNER TO progresseye_owner;
ALTER TABLE "role_permissions" OWNER TO progresseye_owner;
ALTER TABLE "user_roles" OWNER TO progresseye_owner;
ALTER TABLE "audit_logs" OWNER TO progresseye_owner;
ALTER TABLE "audit_logs_y2026m10" OWNER TO progresseye_owner;
ALTER TABLE "audit_logs_y2026m11" OWNER TO progresseye_owner;
ALTER TABLE "audit_logs_y2026m12" OWNER TO progresseye_owner;
ALTER TABLE "audit_logs_y2027m01" OWNER TO progresseye_owner;
ALTER TABLE "audit_logs_default" OWNER TO progresseye_owner;
ALTER TABLE "outbox_events" OWNER TO progresseye_owner;
ALTER TABLE "counters" OWNER TO progresseye_owner;
ALTER TABLE "public_leads" OWNER TO progresseye_owner;

-- Table owner full privileges
GRANT ALL ON ALL TABLES IN SCHEMA public TO progresseye_owner;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO progresseye_owner;
GRANT ALL ON ALL ROUTINES IN SCHEMA public TO progresseye_owner;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO progresseye_owner;

-- Permissions table: Global catalog (Read-only to application role)
GRANT SELECT ON "permissions" TO progresseye_app, progresseye_ro;
REVOKE INSERT, UPDATE, DELETE ON "permissions" FROM progresseye_app, progresseye_ro;

-- Standard tenant & platform tables: SELECT, INSERT, UPDATE, DELETE for app role
GRANT SELECT, INSERT, UPDATE, DELETE ON
    "organizations",
    "schools",
    "academic_years",
    "users",
    "sessions",
    "roles",
    "role_permissions",
    "user_roles",
    "outbox_events",
    "counters",
    "public_leads"
TO progresseye_app;

-- Audit logs: strictly SELECT + INSERT only for app role (Immutable: UPDATE/DELETE denied)
GRANT SELECT, INSERT ON "audit_logs" TO progresseye_app;
REVOKE UPDATE, DELETE ON "audit_logs" FROM progresseye_app;

GRANT SELECT, INSERT ON "audit_logs_y2026m10" TO progresseye_app;
REVOKE UPDATE, DELETE ON "audit_logs_y2026m10" FROM progresseye_app;

GRANT SELECT, INSERT ON "audit_logs_y2026m11" TO progresseye_app;
REVOKE UPDATE, DELETE ON "audit_logs_y2026m11" FROM progresseye_app;

GRANT SELECT, INSERT ON "audit_logs_y2026m12" TO progresseye_app;
REVOKE UPDATE, DELETE ON "audit_logs_y2026m12" FROM progresseye_app;

GRANT SELECT, INSERT ON "audit_logs_y2027m01" TO progresseye_app;
REVOKE UPDATE, DELETE ON "audit_logs_y2027m01" FROM progresseye_app;

GRANT SELECT, INSERT ON "audit_logs_default" TO progresseye_app;
REVOKE UPDATE, DELETE ON "audit_logs_default" FROM progresseye_app;

-- Read-only role: SELECT on all tables
GRANT SELECT ON ALL TABLES IN SCHEMA public TO progresseye_ro;
