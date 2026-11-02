# ADR-007: Tenancy, Row-Level Security (RLS), and Multi-Tenant Isolation Foundation

## Status
Accepted

## Context
ProgressEye is a multi-tenant school operations platform. Ensuring strict tenant isolation at the database layer is an absolute architectural invariant: no school may ever observe, mutate, or query another school's data.

In Phase 11, we implement the multi-tenancy schema foundation in `progresseye-api`. Following ADR-002, we use a shared PostgreSQL 17 database with a shared schema, enforcing tenant boundaries directly in PostgreSQL via native Row-Level Security (RLS) policies rather than relying exclusively on application-level `WHERE school_id = ...` query predicates.

## Decisions

### 1. Table Classification & Schema Taxonomy
Tables in ProgressEye are classified into five distinct operational tiers:

| Table Name | Tier | `school_id` Column | Soft-Delete (`deleted_at`) | RLS Policy & Justification |
| :--- | :--- | :--- | :--- | :--- |
| `organizations` | Multi-Tenant Root | None (Parent entity) | Yes | Group of schools (e.g. academy trusts). Optional parent; does not have `school_id` because it aggregates schools. Access controlled via organization-level policy. |
| `schools` | Tenant Root | None (`id` is tenant PK) | Yes | Root tenant directory. `organization_id` nullable FK. `id` has CHECK constraint rejecting Nil-UUID (`00000000-0000-0000-0000-000000000000`). Public metadata (slug resolution) accessible via SELECT policy; mutations restricted. |
| `academic_years` | Tenant Entity | `school_id NOT NULL UUID` | Yes | Scoped to school. Partial unique index on `(school_id, name) WHERE deleted_at IS NULL`. CHECK constraint rejecting Nil-UUID. |
| `users` | Tenant Entity | `school_id NOT NULL UUID` | Yes | Scoped to school. Partial unique index on `(school_id, email) WHERE deleted_at IS NULL`. CHECK constraint rejecting Nil-UUID. |
| `sessions` | Tenant Entity | `school_id NOT NULL UUID` | No (Immutable/Revocable) | Active authentication sessions. Scoped to school. Revoked via `revoked_at`, no soft deletion. |
| `roles` | Tenant Entity | `school_id NOT NULL UUID` | Yes | Custom and system roles per school. Partial unique index on `(school_id, slug) WHERE deleted_at IS NULL`. |
| `permissions` | Global Catalog | None (System Catalog) | No (Immutable) | Static system permission codes (`code`, `module`, `description`). Shared across all tenants. Read-only to application role. |
| `role_permissions` | Tenant Junction | `school_id NOT NULL UUID` | No (Relational Junction) | Maps tenant roles to global permissions. Composite unique constraint `(school_id, role_id, permission_id)`. |
| `user_roles` | Tenant Junction | `school_id NOT NULL UUID` | No (Relational Junction) | Maps tenant users to tenant roles. Composite unique constraint `(school_id, user_id, role_id)`. |
| `audit_logs` | Tenant Entity (Partitioned) | `school_id NOT NULL UUID` | No (Strictly Immutable) | Partitioned by month (`PARTITION BY RANGE (created_at)`). Composite PK `(id, created_at)`. Append-only. RLS on parent and all child partitions. |
| `outbox_events` | Tenant Entity | `school_id NOT NULL UUID` | No (State Machine) | Transactional outbox for event dispatch. Scoped to school. Updates allowed for state transitions (`PENDING` -> `PROCESSED`). |
| `counters` | Tenant Entity | `school_id NOT NULL UUID` | No (Transactional Sequence) | Sequential numbering per school/year/sequence. Updated via row locks (`SELECT ... FOR UPDATE`). |
| `public_leads` | Platform / Marketing | None (Platform Entity) | No (Retention Expiry) | Pre-tenant lead capture from marketing website. Managed by public marketing flow; outside RLS. |

### 2. Operating without `BYPASSRLS` on Application Role
The application database user `progresseye_app` is provisioned strictly with `NOBYPASSRLS`. To satisfy operational flows without bypassing RLS:

1. **School Resolution by Slug**:
   When an incoming HTTP request arrives with a tenant slug (or subdomain), the application resolves the tenant by slug using a public read policy on `schools` (`SELECT id, slug, name, is_active FROM schools`). No sensitive tenant data is exposed.
2. **Login Lookup before Tenant is Known**:
   In Phase 11, `users` is strictly tenant-scoped with `school_id NOT NULL`. If the user submits their school slug alongside their login credentials, the tenant context is set immediately before looking up the user.
   *Open Decision for Phase 12 (D-042)*: If multi-school single-sign-on or global email lookup (without prior tenant slug) is introduced in Phase 12, it will be implemented via an explicit, audited `SECURITY DEFINER` function owned by `progresseye_owner` that returns the matching `school_id` and hashed credentials without granting `BYPASSRLS` to `progresseye_app`. The Phase 11 schema explicitly accommodates this without modification.
3. **Platform-Admin & Support Access**:
   Platform administrators and support staff do NOT bypass RLS globally. When diagnosing a tenant issue, the administrative session explicitly sets `app.current_school_id` to the target tenant, creating an immutable `audit_logs` entry documenting support impersonation.
4. **Organization-Level Access**:
   Multi-school entities (e.g. trusts/districts) query member schools by iterating across member `school_id` values in separate tenant-scoped transactions, or through a dedicated organization-level policy in Phase 13.

### 3. Tenant Context Injection & Nil-UUID Fail-Closed Mechanism
- Tenant context is set per transaction via PostgreSQL's built-in session parameter function:
  ```sql
  SELECT set_config('app.current_school_id', $1, true);
  ```
- **Strict Parameterization**: The tenant ID `$1` is passed strictly as a bound parameter following UUID validation (via regex and standard UUID parse). String interpolation (`SET LOCAL app.current_school_id = '...'`) is strictly prohibited.
- **Fail-Closed Protection**:
  All tenant RLS policies evaluate:
  ```sql
  school_id = COALESCE(NULLIF(current_setting('app.current_school_id', true), ''), '00000000-0000-0000-0000-000000000000')::uuid
  ```
  If `app.current_school_id` is missing or empty, `NULLIF` evaluates to `NULL`, and `COALESCE` defaults to the Nil-UUID (`00000000-0000-0000-0000-000000000000`).
  Because all tenant tables enforce `CHECK (school_id <> '00000000-0000-0000-0000-000000000000'::uuid)` (and `schools.id <> '00000000-...'`), zero rows can ever match when context is absent.

### 4. Partitioned Audit Logs & Immutability Guarantees
- The `audit_logs` table is partitioned by month using `PARTITION BY RANGE (created_at)`.
- RLS policies and `FORCE ROW LEVEL SECURITY` are applied to both the parent `audit_logs` table and each underlying monthly child partition (`audit_logs_yYYYYmMM`).
- Database privilege grants for `progresseye_app` on `audit_logs` and its partitions are restricted strictly to `SELECT` and `INSERT`. `UPDATE` and `DELETE` privileges are explicitly revoked.

### 5. AWS RDS Master Role Compatibility
- In AWS RDS PostgreSQL, the administrative user (`rds_superuser`) is not a native PostgreSQL superuser.
- While `ALTER TABLE ... FORCE ROW LEVEL SECURITY` and `CREATE POLICY` operate cleanly, operations altering role superuser attributes differ from plain PostgreSQL.
- Database provisioning documentation marks RDS-specific steps as `UNVERIFIED` pending staging deployment, referencing the AWS RDS PostgreSQL documentation:
  `https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/UsingWithRDS.MasterAccounts.html`
- CI runs against plain PostgreSQL 17 containers.

### 6. Prisma Client Extension Implementation
- Multi-tenancy is integrated into Prisma Client via a custom client extension (`$extends`).
- The extension intercepts model queries, `$queryRaw`, and `$executeRaw`.
- When an outer transaction is already active, the extension executes within the existing transaction without nesting; otherwise, it opens an interactive transaction, executes `set_config('app.current_school_id', $1, true)`, and runs the target operation.

## Consequences
### Positive
- Cross-tenant data leakage is physically prevented by the PostgreSQL kernel.
- Complete fail-closed security: missing, blank, or malformed tenant context yields empty results.
- Soft-deleted records do not conflict with active records due to partial unique indexes.
- Audit logs are tamper-proof and immutable against the application role.

### Negative / Trade-offs
- Setting transaction configuration adds a negligible overhead (~0.2ms) per transaction.
- Partition maintenance requires a scheduled background task to pre-provision future monthly partitions.
