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
- Roles are segregated strictly between Platform and Tenant:
  - **System Platform Tenant** (`00000000-0000-0000-0000-000000000001` / `system-platform`): Exactly 1 built-in role (`platform_admin`).
  - **Tenant Schools**: Exactly 12 built-in system roles (tenant roles cannot hold `platform.*` permissions):
    1. `principal`: School executive with all 38 tenant permissions (`tenancy.*`, `identity.*`, `academic.*`, `people.*`, `attendance.*`, `assessment.*`, `finance.*`, `communication.*`, `operations.*`, `documents.*`).
    2. `teacher`: Academic, classroom, assigned section attendance, and subject grade management.
    3. `student`: Self-only profile, attendance, grades, and fee receipts.
    4. `parent`: Linked-children profile, attendance, grades, and fee payment.
    5. `accountant`: Tuition fees, invoices, payments, financial ledger, and student directory lookup.
    6. `librarian`: Book catalog, reservations, and circulation.
    7. `receptionist`: Visitor logs, admissions intake, directory search.
    8. `exam_coordinator`: Exam scheduling, assessment grading, and report card generation.
    9. `transport_manager`: Vehicle fleets, transit routes, and student bus stops.
    10. `hostel_warden`: Hostel rooms, dorm allocation, and residential attendance (6 permissions).
    11. `nurse`: Student clinic visits, medical records, and allergy alerts.
    12. `counselor`: Confidential counseling notes and student support sessions.
- **Tenant Seeding Routine**:
  - Seeding the 12 built-in roles runs under the target school's tenant context (`SELECT set_config('app.current_school_id', '<schoolId>', true)`).
  - Marked with `is_system = true` in the `roles` table. System roles cannot be renamed, deleted, or stripped of their core permissions.
  - Seeding is strictly idempotent: re-running the seed executes upserts on `(school_id, slug)` and updates `role_permissions` without duplicating rows or raising unique constraint errors.
  - In migrations and scripts running as `progresseye_owner` under `FORCE ROW LEVEL SECURITY`, bare DML without tenant context affects 0 rows. Seeding and migration cleanups loop per school with `set_config` inside an isolated transaction.

### 3. CASL Ability Engine & Attribute Stubs
- `@casl/ability` is pinned to exact version `6.7.5` in `package.json` (`"@casl/ability": "6.7.5"`) to resolve prototype pollution vulnerability GHSA-x9vf-53q3-cvx6 present in versions `<= 6.7.4`.
- Dependency audit verified via `pnpm audit --prod --audit-level high` yielding 0 high and 0 critical vulnerabilities (`12 vulnerabilities found; Severity: 5 low | 7 moderate`).
- An `AbilityFactory` compiles a user's effective permissions into an executable CASL `AppAbility`.
- **Attribute Conditions**: Attribute-based constraints (such as `assignedSections` for teachers, `linkedChildren` for parents, and `self` for students) are evaluated synchronously in memory against authenticated request user context properties.
- **Phase 15/16 Forward Compatibility**: In Phase 13, attribute conditions are defined as typed stubs that inspect user context metadata, avoiding premature SQL joins against tables that do not yet exist (e.g. `sections`, `guardians`).
- **Student and Child Data Protection Rule**: Permissions that grant student/child data (`people.student.read`, `attendance.record.read`, `assessment.exam.read`, `finance.invoice.read`, `finance.payment.record`, `documents.record.read`) must NOT be wired to any route until the attribute conditions (teacher sections, parent children, student self) exist in Phases 15/16. Wiring them before attribute filtering is active would create cross-student or cross-child data exposure.

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
  - In Phase 13b-1, tenant provisioning uses a narrow PostgreSQL `SECURITY DEFINER` function:
    `platform_provision_school(p_slug, p_name, p_organization_id)`
  - Hardened with `SET search_path = public, pg_temp;`.
  - `REVOKE ALL ON FUNCTION platform_provision_school FROM PUBLIC;`
  - `GRANT EXECUTE ON FUNCTION platform_provision_school TO progresseye_app;`
  - Input validation sanitizes slugs and names. Checks against reserved system slugs (`'system-platform'`, `'platform'`, `'admin'`, `'api'`, `'app'`, `'public'`, `'system'`, `'root'`, `'support'`, `'billing'`).
  - Writes an initial audit row inside the same database transaction.
  - Gated at the application layer by `PlatformGuard` + `@RequirePermission('create', 'platform.school')`.
  - **Uncached Live PlatformGuard Verification**:
    - `PlatformGuard` executes a direct database query under `SYSTEM_TENANT_ID` on every incoming request without Redis caching.
    - Zero caching eliminates cache invalidation latency and state drift, guaranteeing that administrator deactivation (`isActive: false`), role revocation (removal of `platform_admin`), or session invalidation (`revokedAt != null`) takes effect instantaneously on the very next HTTP request.
  - **Risk Assessment**: `progresseye_app` has `EXECUTE` privilege on this function, meaning if SQL injection were present in the application, an attacker could provision schools. This risk is mitigated by parameterized queries, strict input validation, slug regex `^[a-z0-9]+(-[a-z0-9]+)*$`, and application-level role checks. The function cannot read or modify any other tenant's data beyond creating the new tenant root.
- **Role Seeding and Cross-Tenant Execution (`withPlatformTenant`)**:
  - Once `platform_provision_school` creates the school row, role seeding executes via `withPlatformTenant(targetSchoolId, op, options)`.
  - `withPlatformTenant` sets `app.current_school_id = targetSchoolId`, executes the callback, inserts an append-only audit row into `platform_audit_logs`, and closes BACKLOG item 8 by being the sole authorized cross-tenant caller of `withTenant`.
  - Reseeding and role repair is supported via `POST /api/v1/platform/schools/:id/reseed-roles`.
- **Platform Audit Logs**:
  - Table `platform_audit_logs` is created in Phase 13b-1:
    - Global append-only sink (no `school_id` foreign key, no tenant RLS, owned by `progresseye_owner`).
    - Grants: `GRANT INSERT ON platform_audit_logs TO progresseye_app; REVOKE SELECT, UPDATE, DELETE, TRUNCATE FROM progresseye_app; GRANT SELECT ON platform_audit_logs TO progresseye_ro, progresseye_owner;`.
    - Because `progresseye_app` has `INSERT` only (no `SELECT`), the application uses raw SQL `$executeRaw` without `RETURNING`.
    - Captures client IP HMAC-SHA256 hash using `AUTH_LOG_HMAC_SECRET`.
    - Payload captures IDs and non-sensitive field names only; sensitive values are redacted.
- **Bootstrap Routine**:
  - CLI script `scripts/bootstrap-platform-admin.ts` provides a secure initialization path.
  - Requires `PLATFORM_BOOTSTRAP_SECRET` (minimum 32 chars).
  - Blocked in production unless `ENABLE_PLATFORM_BOOTSTRAP=true`.
  - Refuses to run if any platform admin already exists.
  - Generates a random one-time password displayed once.
  - Mandates 2FA setup on first login (`isTwoFactorEnabled: false` with forced `platform_2fa_setup_pending`).
- **Cloud Environment Nuances**:
  - Behavior under managed connection poolers (AWS RDS Proxy, Supabase PgBouncer in transaction mode) with PostgreSQL RLS is marked **UNVERIFIED** and will be verified on staging infrastructure.

### 9. Guard-Level 2FA Enforcement & Principal Onboarding Flow
- **Guard-Level 2FA Enforcement Rule (Phase 13b-2)**:
  - Role-based 2FA enforcement: Any user holding a role with sensitive permissions (`platform.*`, `identity.role.assign`, `finance.*`) is mandated to use 2FA. This covers `platform_admin`, `principal`, and `accountant`.
  - Guard check runs before the `@Authenticated` early return, with an explicit exemption list (2FA setup and enable endpoints).
  - The `requires_2fa` requirement is derived from the fixed sensitive-permission list, is not copied on role clone, and cannot be edited down on custom roles.
  - Real 2FA fixtures in e2e tests; no test-only bypass flag is permitted.
- **Principal Onboarding Flow**:
  - Onboarding invite tokens are compound strings: `<schoolId>.<random32ByteHex>`, hashed at rest with SHA-256 (`code_hash`).
  - Redeeming an invite sets `used_at = CURRENT_TIMESTAMP(3)` and creates the principal user account with `is_two_factor_enabled = false`.
  - The access token issued on join carries `scope: "2fa_setup_pending"`.
  - `JwtAuthGuard` restricts `2fa_setup_pending` tokens strictly to `POST /api/v1/auth/2fa/setup` and `POST /api/v1/auth/2fa/enable`. All other API routes reject the request with `403 Forbidden` (`2FA_SETUP_REQUIRED`).
  - Calling `enable2Fa` with `2fa_setup_pending` scope activates 2FA and immediately issues a full access session (access token + refresh cookie), eliminating the need for a separate login step.

### 10. AuditInterceptor Contract (Phase 13b-2)
- An `AuditInterceptor` captures all mutating requests (`POST`, `PUT`, `PATCH`, `DELETE`).
- Captures: actor user ID, tenant school ID, target entity, request ID, and a before/after diff of modified fields.
- Field values are sanitized using an allow-list; sensitive fields and personal identifiable information (PII) are logged as `"changed"` only without logging raw values.
- Critical and platform operations fail immediately if audit logging fails (fail-closed).
- Audit log retention policy follows `TODO-REAL-DATA`.

### 11. Conscious Architectural Deviations
1. **System Tenant + `SECURITY DEFINER` vs Phase 11's Separate Platform Policies**:
   - In Phase 11, the design contemplated adding separate platform-level RLS policies on each table.
   - *Deviation*: Phase 13 adopts a dedicated system tenant (`00000000-0000-0000-0000-000000000001` / `system-platform`) combined with a narrow PostgreSQL `SECURITY DEFINER` function (`platform_provision_school`).
   - *Rationale*: Eliminates complex multi-branch RLS policies that could degrade query performance across millions of tenant rows, prevents accidental bypass bugs, and cleanly bounds cross-tenant provisioning inside a single vetted database function.
2. **Principal Sets Password at Join**:
   - Rather than sending a temporary password and forcing a password change on first login, the onboarding invite redemption endpoint allows the invited principal to set their initial strong password directly.
   - *Rationale*: Cryptographically equivalent to first-login password change, reduces email exposure of credentials, and simplifies the user onboarding experience while enforcing mandatory 2FA enrollment.
3. **Attribute-Based Rules Deferred to Phases 15/16**:
   - Fine-grained attribute rules (teacher section assignment, parent child linking) are deferred until the corresponding domain tables (`sections`, `guardians`) are provisioned in Phases 15 and 16.
   - *Guard*: Permissions accessing student/child data are prohibited from being wired to open routes until these attribute constraints exist.
4. **Subscription Plan Stub**:
   - A full subscription billing catalog is deferred to the billing and payments phase. In Phase 13, subscription plans are stubbed or managed via feature flags without a dedicated billing engine.
