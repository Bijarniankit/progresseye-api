# ADR-011: Authorization, Role Designer, and School Onboarding (Phase 13)

## Status
Accepted

## Context
Following Phase 12 (Authentication, Session Management, Account Lifecycle, and Two-Factor Authentication), ProgressEye requires a comprehensive, fine-grained authorization system (Phase 13a) and a secure tenant onboarding workflow (Phase 13b).
The application enforces strict PostgreSQL Row-Level Security (`progresseye_app` runs strictly `NOBYPASSRLS`). The authorization architecture must enforce:
1. Granular permission checking on every controller route (`module.resource.action`).
2. 13 built-in system roles seeded idempotently per school tenant.
3. Attribute-based access control (ABAC) via CASL abilities for subject and ownership constraints.
4. Strict anti-escalation controls preventing actors from granting permissions they do not possess, self-assigning roles, or mutating their own roles to escalate privileges.
5. Last-admin lockout protection preventing a school from being left with zero active administrators.
6. Stale token defense using a Redis permission cache with PostgreSQL database fallback, invalidated in real-time upon any role or permission modification.
7. Explicit architecture for platform administration, tenant onboarding, and audit logging.

---

## Decisions

### 1. Permission Naming & Global System Catalog
- Permissions follow the canonical hierarchy: `<module>.<resource>.<action>` (e.g., `identity.user.create`, `tenancy.role.update`, `academic.class.read`).
- The `permissions` table is a global system catalog without `school_id`. The application role `progresseye_app` has `SELECT` privileges only (`REVOKE INSERT, UPDATE, DELETE`).
- Permissions are seeded from code (`permissions.catalog.ts`) using the schema owner role (`progresseye_owner`).
- **Phase 13a Database Scope**:
  - Phase 13a introduces zero database tables and zero database migrations. The underlying RBAC tables (`roles`, `permissions`, `role_permissions`, `user_roles`) were created in Phase 11 (`20261108000000_tenancy_and_rls`) with complete PostgreSQL Row-Level Security policies and indexes.
  - Future tables `platform_audit_logs`, `school_invites`, `school_features`, `subscription_plans`, and the `SECURITY DEFINER` provisioning function (`platform_provision_school`) live in **Phase 13b**.
- **Segregation of Platform vs Tenant Permissions**:
  - Permissions prefixed with `platform.` (such as `platform.school.create`, `platform.school.read`, `platform.plan.manage`) are reserved exclusively for platform operations.
  - **Mechanism**: The `RoleService` (`createRole`, `cloneRole`, `updateRole`) programmatically inspects all requested permission codes using `isPlatformPermission(code)` (`code.startsWith("platform.")`). If any platform permission is detected in a tenant role operation, it immediately throws `ForbiddenException("Platform permissions (platform.*) cannot be assigned to tenant roles")`.
  - **Verification Tests**:
    - Unit test: `RoleService -> Anti-Escalation Engine -> should reject creating role with platform.* permissions` (`src/modules/identity/application/role.service.spec.ts`)
    - E2E test: `Phase 13a: Authorization & Role Designer E2E Suite -> Attack & Security Verification -> Platform Permission Isolation: tenant admin cannot create role with platform.* permissions` (`test/e2e/authorization-roles.e2e-spec.ts`)

### 2. Built-in Roles & Idempotent Tenant Seeding
- Exactly 13 built-in system roles are defined:
  1. `platform_admin`: Superuser role for ProgressEye platform operators (`platform.*`).
  2. `principal`: School executive with all tenant permissions (`tenancy.*`, `identity.*`, `academic.*`, `people.*`, `attendance.*`, `assessment.*`, `finance.*`, `communication.*`, `operations.*`, `documents.*`).
  3. `teacher`: Academic, classroom, assigned section attendance, and subject grade management.
  4. `student`: Self-only profile, attendance, grades, and fee receipts.
  5. `parent`: Linked-children profile, attendance, grades, and fee payment.
  6. `accountant`: Tuition fees, invoices, payments, financial ledger, and student directory lookup.
  7. `librarian`: Book catalog, reservations, and circulation.
  8. `receptionist`: Visitor logs, admissions intake, directory search.
  9. `exam_coordinator`: Exam scheduling, assessment grading, and report card generation.
  10. `transport_manager`: Vehicle fleets, transit routes, and student bus stops.
  11. `hostel_warden`: Hostel rooms, dorm allocation, and residential attendance.
  12. `nurse`: Student clinic visits, medical records, and allergy alerts.
  13. `counselor`: Confidential counseling notes and student support sessions.
- **Tenant Seeding Routine**:
  - Seeding the 13 built-in roles runs under the target school's tenant context (`SET LOCAL app.current_school_id = '<schoolId>'`).
  - Marked with `is_system = true` in the `roles` table. System roles cannot be renamed, deleted, or stripped of their core permissions.
  - Seeding is strictly idempotent: re-running the seed executes upserts on `(school_id, slug)` and updates `role_permissions` without duplicating rows or raising unique constraint errors.

### 3. CASL Ability Engine & Attribute Stubs
- `@casl/ability` is pinned to exact version `6.7.5` in `package.json` (`"@casl/ability": "6.7.5"`) to resolve prototype pollution vulnerability GHSA-x9vf-53q3-cvx6 present in versions `<= 6.7.4`.
- Dependency audit verified via `pnpm audit --prod --audit-level high` yielding 0 high and 0 critical vulnerabilities (`12 vulnerabilities found; Severity: 5 low | 7 moderate`).
- An `AbilityFactory` compiles a user's effective permissions into an executable CASL `AppAbility`.
- **Attribute Conditions**: Attribute-based constraints (such as `assignedSections` for teachers, `linkedChildren` for parents, and `self` for students) are evaluated synchronously in memory against authenticated request user context properties.
- **Phase 15/16 Forward Compatibility**: In Phase 13, attribute conditions are defined as typed stubs that inspect user context metadata, avoiding premature SQL joins against tables that do not yet exist (e.g. `sections`, `guardians`).

### 4. Route Coverage Guard & Decorators
- Every endpoint in the API must declare an authorization policy:
  - `@RequirePermission(action, resource)`: Requires the authenticated user to hold the specified permission code.
  - `@Public(justification)`: Explicitly exempts the endpoint from authentication and permission checks (e.g., public health checks, login, lead submission). A non-empty justification string is mandatory.
- **`PoliciesGuard`**:
  - Executes immediately after `JwtAuthGuard`.
  - Extracts the user identity (`userId`, `schoolId`) from `request.user`.
  - Retrieves effective permissions for `(school_id, user_id)`.
  - Verifies that the user possesses the required permission(s) via the CASL ability.
- **CI Route Coverage Test**:
  - `route-permission-coverage.spec.ts` introspects all controller endpoints registered across the NestJS HTTP adapter.
  - CI fails if any route lacks both `@RequirePermission` and `@Public`.

### 5. Stale Token Defense & Redis Permission Cache
- **JWT Content**: Access token JWTs contain only identity claims (`sub`, `schoolId`, `sessionId`, `scope`). JWTs **never** embed role names or permission sets.
- **Cache Architecture**:
  - Effective permissions are cached in Redis under `auth:perm:<schoolId>:<userId>` with a 15-minute TTL.
  - Key operations use a short 250ms Redis timeout.
- **Cache Invalidation**:
  - Modifying a role's permissions evicts the cache for all active users assigned that role.
  - Assigning or unassigning a user's role evicts that specific user's cache.
  - Deactivating a user immediately purges their permission cache and revokes their active sessions.
- **Redis-Down Graceful Degradation**:
  - If Redis is unavailable or times out, `PoliciesGuard` catches the error, logs a warning, and falls back directly to a PostgreSQL query to compute effective permissions.
  - Unlike 2FA replay protection (which returns 503 to prevent replay), authorized requests continue to succeed (200 OK) when Redis is down.

### 6. Anti-Escalation Engine
- **Subset Enforcement**:
  - When creating a custom role, updating a role, or cloning an existing role, the requested permission set must be a strict subset of the acting user's own effective permissions:
    $$\text{requestedPermissions} \subseteq \text{actorEffectivePermissions}$$
  - An actor cannot grant permissions they do not personally hold.
- **Assignment & Self-Assignment**:
  - An actor cannot assign a role containing permissions that the actor does not possess.
  - An actor cannot assign any role to themselves (`CANNOT_SELF_ASSIGN_ROLE`).
  - An actor cannot modify the permission set of their own assigned role (`CANNOT_EDIT_OWN_ROLE`).

### 7. Last-Admin Lockout Guard
- **Definition of Administrator**:
  - An administrator is defined as an active user assigned a role with the full administrative permission set (including `identity.role.assign`, `tenancy.school.update`, or the built-in `principal` role).
- **Protected Operations**:
  - Deleting an admin role.
  - Unassigning an admin user from their admin role.
  - Deactivating an admin user.
  - Updating an admin role to strip administrative permissions.
- **Concurrency & Row Locking**:
  - Evaluated inside an isolated database transaction with row-level locking (`SELECT ... FOR UPDATE` on `user_roles` and `users`) to ensure concurrent requests cannot race to remove the last admin.
  - If the operation would leave zero active administrators in the school, the transaction aborts with `400 Bad Request` (`CANNOT_REMOVE_LAST_ADMIN`).

### 8. Platform Administration & Architecture (Phase 13b)
- **Storage of Platform Admins**:
  - In PostgreSQL, the `users` table enforces `school_id NOT NULL UUID`.
  - Platform administrators belong to a designated system tenant (`00000000-0000-0000-0000-000000000001` or dedicated system slug `system-platform`).
  - Platform authentication is a distinct endpoint (`POST /api/v1/platform/auth/login`) that strictly enforces mandatory TOTP 2FA before issuing a platform token (`scope: "platform"`).
- **Provisioning without BYPASSRLS on `progresseye_app`**:
  - In Phase 13b, tenant provisioning uses a narrow PostgreSQL `SECURITY DEFINER` function:
    `platform_provision_school(p_slug, p_name, p_admin_email, ...)`
  - Hardened with `SET search_path = public, pg_temp;`.
  - `REVOKE ALL ON FUNCTION platform_provision_school FROM PUBLIC;`
  - `GRANT EXECUTE ON FUNCTION platform_provision_school TO progresseye_app;`
  - Input validation sanitizes slugs and emails. Gated at the application layer by `RequirePermission('platform.school.create')`.
  - The function cannot read or modify any other tenant's data beyond creating the new tenant root and seeding its default system roles.
- **Platform Audit Logs**:
  - Table `platform_audit_logs` is created in Phase 13b (append-only, no `school_id`, no tenant RLS, owned by `progresseye_owner`, `GRANT SELECT, INSERT ON platform_audit_logs TO progresseye_app; REVOKE UPDATE, DELETE`).
- **Cloud Environment Nuances**:
  - Behavior under managed connection poolers (AWS RDS Proxy, Supabase PgBouncer in transaction mode) with PostgreSQL RLS is marked **UNVERIFIED** and will be verified on staging infrastructure.

### 9. Principal 2FA Enforcement & Onboarding Flow (Phase 13b)
- Onboarding invite tokens are compound strings: `<schoolId>.<random32ByteHex>`, hashed at rest with SHA-256 (`code_hash`).
- Redeeming an invite sets `used_at = CURRENT_TIMESTAMP(3)` and creates the principal user account with `is_two_factor_enabled = false`.
- The access token issued on join carries `scope: "2fa_setup_pending"`.
- `JwtAuthGuard` restricts `2fa_setup_pending` tokens strictly to `POST /api/v1/auth/2fa/setup` and `POST /api/v1/auth/2fa/enable`. All other API routes reject the request with `403 Forbidden` (`2FA_SETUP_REQUIRED`).

### 10. Audit Logging for Role Changes
- Any role creation, role update, role deletion, or role assignment explicitly logs a structured tenant audit record into `audit_logs`:
  - `action`: `ROLE_CREATE`, `ROLE_UPDATE`, `ROLE_DELETE`, `ROLE_ASSIGN`, `ROLE_UNASSIGN`.
  - `resource`: `roles` or `user_roles`.
  - `payload`: Records role metadata, changed permissions diff, target user ID, and actor ID.
  - Sensitive credentials (passwords, tokens, keys) are redacted.
