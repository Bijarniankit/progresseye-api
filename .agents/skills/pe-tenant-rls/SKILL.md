---
name: pe-tenant-rls
description: Standard operational rules for PostgreSQL Row-Level Security (RLS), tenant context isolation, role privileges, and AsyncLocalStorage scoping in ProgressEye API.
---
# ProgressEye Tenant Row-Level Security (RLS) Standard

## 1. Core Security Model
- ProgressEye uses a shared database, shared schema multi-tenancy model backed by PostgreSQL native Row-Level Security (RLS).
- The application database role (`progresseye_app`) runs strictly without `BYPASSRLS` (`NOBYPASSRLS`).
- All tenant tables must have both `ENABLE ROW LEVEL SECURITY` and `FORCE ROW LEVEL SECURITY` enabled. `FORCE` ensures table owners or privileged users cannot bypass policies during routine queries.

## 2. Setting Tenant Context safely
- Tenant context is bound per-request via `AsyncLocalStorage`.
- Tenant context is injected into PostgreSQL sessions strictly via parameterized query:
  ```sql
  SELECT set_config('app.current_school_id', $1, true);
  ```
  Setting the 3rd argument to `true` scopes the setting strictly to the current database transaction (`SET LOCAL`).
- String-interpolated `SET LOCAL` is strictly forbidden to prevent SQL injection.
- The parameter MUST be validated as a valid UUID before `set_config` is called.

## 3. Fail-Closed RLS Policy Pattern
- RLS policies on tenant tables evaluate:
  ```sql
  CREATE POLICY "tenant_isolation_policy" ON "<table_name>"
    FOR ALL
    TO progresseye_app
    USING (
      school_id = COALESCE(NULLIF(current_setting('app.current_school_id', true), ''), '00000000-0000-0000-0000-000000000000')::uuid
    )
    WITH CHECK (
      school_id = COALESCE(NULLIF(current_setting('app.current_school_id', true), ''), '00000000-0000-0000-0000-000000000000')::uuid
    );
  ```
- If `app.current_school_id` is missing or empty, `NULLIF` returns NULL, and `COALESCE` defaults to Nil-UUID (`00000000-0000-0000-0000-000000000000`).
- Because a check constraint guarantees no school or tenant row can possess a Nil-UUID, any query executed without tenant context matches 0 rows (fail closed).

## 4. Partitioned Tables (Audit Logs)
- For partitioned tables (e.g. `audit_logs` partitioned by month), RLS must be enabled and forced on the parent table and on all individual child partitions.
- The `progresseye_app` role receives `SELECT, INSERT` privileges only on audit tables; `UPDATE` and `DELETE` privileges are explicitly revoked to preserve immutable audit trails.
