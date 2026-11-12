-- ---------------------------------------------------------
-- Phase 13b-1: Platform Provisioning, System Tenant, and Platform Audit Logs
-- ---------------------------------------------------------

-- 1. Create platform_audit_logs table (Global Append-Only Sink)
CREATE TABLE "platform_audit_logs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "actor_user_id" UUID,
    "action" TEXT NOT NULL,
    "resource" TEXT NOT NULL,
    "resource_id" TEXT,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "client_ip_hash" TEXT,
    "user_agent" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    CONSTRAINT "platform_audit_logs_pkey" PRIMARY KEY ("id")
);

-- Index for temporal ordering and entity querying
CREATE INDEX "platform_audit_logs_created_at_idx" ON "platform_audit_logs"("created_at");
CREATE INDEX "platform_audit_logs_resource_idx" ON "platform_audit_logs"("resource", "resource_id");

-- Security: Append-Only grants (INSERT only for app, SELECT for ro and owner)
ALTER TABLE "platform_audit_logs" OWNER TO progresseye_owner;
GRANT INSERT ON "platform_audit_logs" TO progresseye_app;
REVOKE SELECT, UPDATE, DELETE, TRUNCATE ON "platform_audit_logs" FROM progresseye_app;
GRANT SELECT ON "platform_audit_logs" TO progresseye_ro, progresseye_owner;

-- 2. System Tenant Root (00000000-0000-0000-0000-000000000001 / system-platform)
DO $$
BEGIN
    PERFORM set_config('app.current_school_id', '00000000-0000-0000-0000-000000000001', true);

    INSERT INTO "schools" ("id", "name", "slug", "is_active", "created_at", "updated_at")
    VALUES (
        '00000000-0000-0000-0000-000000000001'::uuid,
        'ProgressEye Platform Engine',
        'system-platform',
        true,
        CURRENT_TIMESTAMP(3),
        CURRENT_TIMESTAMP(3)
    )
    ON CONFLICT ("id") DO NOTHING;

    PERFORM set_config('app.current_school_id', '', true);
END $$;

-- 3. Catalog adjustments: add platform.invite.create and remove obsolete identity.auth.manage
INSERT INTO "permissions" ("id", "code", "module", "description", "created_at")
VALUES (
    gen_random_uuid(),
    'platform.invite.create',
    'platform',
    'Create and dispatch principal onboarding invites for tenant schools',
    CURRENT_TIMESTAMP(3)
)
ON CONFLICT ("code") DO NOTHING;

DELETE FROM "permissions" WHERE "code" = 'identity.auth.manage';

-- 4. Seed platform_admin role in system tenant root
DO $$
DECLARE
    v_role_id UUID;
    v_perm RECORD;
BEGIN
    PERFORM set_config('app.current_school_id', '00000000-0000-0000-0000-000000000001', true);

    SELECT id INTO v_role_id FROM roles
    WHERE school_id = '00000000-0000-0000-0000-000000000001'::uuid AND slug = 'platform_admin';

    IF v_role_id IS NULL THEN
        v_role_id := gen_random_uuid();
        INSERT INTO roles (id, school_id, name, slug, description, is_system, created_at, updated_at)
        VALUES (
            v_role_id,
            '00000000-0000-0000-0000-000000000001'::uuid,
            'Platform Administrator',
            'platform_admin',
            'ProgressEye system administrator with full platform-level privileges',
            true,
            CURRENT_TIMESTAMP(3),
            CURRENT_TIMESTAMP(3)
        );
    END IF;

    FOR v_perm IN (
        SELECT id FROM permissions WHERE code LIKE 'platform.%'
    ) LOOP
        INSERT INTO role_permissions (id, school_id, role_id, permission_id, created_at)
        VALUES (
            gen_random_uuid(),
            '00000000-0000-0000-0000-000000000001'::uuid,
            v_role_id,
            v_perm.id,
            CURRENT_TIMESTAMP(3)
        )
        ON CONFLICT ("school_id", "role_id", "permission_id") DO NOTHING;
    END LOOP;

    PERFORM set_config('app.current_school_id', '', true);
END $$;

-- 5. Data Cleanup: Remove platform_admin role and permissions from all tenant schools (under FORCE RLS)
DO $$
DECLARE
    r RECORD;
BEGIN
    PERFORM set_config('app.current_school_id', '', false);

    FOR r IN (
        SELECT s.id AS school_id
        FROM schools s
        WHERE s.id <> '00000000-0000-0000-0000-000000000001'::uuid
    ) LOOP
        PERFORM set_config('app.current_school_id', r.school_id::text, false);

        DELETE FROM role_permissions
        WHERE role_id IN (
            SELECT id FROM roles WHERE slug = 'platform_admin' AND school_id = r.school_id
        ) AND school_id = r.school_id;

        DELETE FROM user_roles
        WHERE role_id IN (
            SELECT id FROM roles WHERE slug = 'platform_admin' AND school_id = r.school_id
        ) AND school_id = r.school_id;

        DELETE FROM roles
        WHERE slug = 'platform_admin' AND school_id = r.school_id;
    END LOOP;

    PERFORM set_config('app.current_school_id', '', false);
END $$;

-- 6. SECURITY DEFINER Provisioning Function
CREATE OR REPLACE FUNCTION platform_provision_school(
    p_slug TEXT,
    p_name TEXT,
    p_organization_id UUID DEFAULT NULL
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_school_id UUID;
    v_normalized_slug TEXT;
    v_prev_tenant TEXT;
BEGIN
    -- 1. Input validation
    IF p_slug IS NULL OR length(trim(p_slug)) < 3 OR length(trim(p_slug)) > 63 THEN
        RAISE EXCEPTION 'INVALID_SLUG: slug length must be between 3 and 63 characters';
    END IF;

    v_normalized_slug := lower(trim(p_slug));
    IF v_normalized_slug !~ '^[a-z0-9]+(-[a-z0-9]+)*$' THEN
        RAISE EXCEPTION 'INVALID_SLUG: slug must be alphanumeric with hyphens';
    END IF;

    -- Reserved system slugs check
    IF v_normalized_slug IN ('system-platform', 'platform', 'admin', 'api', 'app', 'public', 'system', 'root', 'support', 'billing') THEN
        RAISE EXCEPTION 'RESERVED_SLUG: % is a reserved system slug', v_normalized_slug;
    END IF;

    IF p_name IS NULL OR length(trim(p_name)) < 1 OR length(trim(p_name)) > 255 THEN
        RAISE EXCEPTION 'INVALID_NAME: name length must be between 1 and 255 characters';
    END IF;

    -- Save previous tenant context
    v_prev_tenant := current_setting('app.current_school_id', true);

    -- Check uniqueness across all schools (empty setting allows seeing all active schools under schools_tenant_isolation)
    PERFORM set_config('app.current_school_id', '', true);
    IF EXISTS (SELECT 1 FROM schools WHERE slug = v_normalized_slug AND deleted_at IS NULL) THEN
        IF v_prev_tenant IS NOT NULL AND v_prev_tenant <> '' THEN
            PERFORM set_config('app.current_school_id', v_prev_tenant, true);
        END IF;
        RAISE EXCEPTION 'SLUG_ALREADY_EXISTS: school with slug % already exists', v_normalized_slug;
    END IF;

    -- 2. Insert new school root (temporarily switch context to new school id to satisfy schools_tenant_isolation WITH CHECK)
    v_school_id := gen_random_uuid();
    PERFORM set_config('app.current_school_id', v_school_id::text, true);

    INSERT INTO schools (id, name, slug, organization_id, is_active, created_at, updated_at)
    VALUES (v_school_id, trim(p_name), v_normalized_slug, p_organization_id, true, CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3));

    -- Restore previous tenant context
    IF v_prev_tenant IS NOT NULL AND v_prev_tenant <> '' THEN
        PERFORM set_config('app.current_school_id', v_prev_tenant, true);
    ELSE
        PERFORM set_config('app.current_school_id', '', true);
    END IF;

    -- 3. Audit log in same transaction
    INSERT INTO platform_audit_logs (id, actor_user_id, action, resource, resource_id, payload, client_ip_hash, user_agent, created_at)
    VALUES (
        gen_random_uuid(),
        NULL,
        'PLATFORM_SCHOOL_PROVISION_INIT',
        'schools',
        v_school_id::text,
        jsonb_build_object('slug', v_normalized_slug, 'schoolId', v_school_id::text, 'fields', jsonb_build_array('name', 'slug')),
        NULL,
        'PostgreSQL Function platform_provision_school',
        CURRENT_TIMESTAMP(3)
    );

    RETURN v_school_id;
END;
$$;

ALTER FUNCTION platform_provision_school(TEXT, TEXT, UUID) OWNER TO progresseye_owner;
REVOKE ALL ON FUNCTION platform_provision_school(TEXT, TEXT, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform_provision_school(TEXT, TEXT, UUID) TO progresseye_app;
