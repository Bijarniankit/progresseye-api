---
name: pe-e2e-testing
description: Standard practices for end-to-end integration and isolation testing of database, multi-tenancy, and API endpoints in ProgressEye API.
---
# ProgressEye End-to-End Testing Standard

## 1. Test Environment & Services
- End-to-end tests run against real containerized infrastructure: PostgreSQL 17, Redis 7, and Mailpit.
- In CI, services are provided via GitHub Actions service containers.
- In local development, services run via `docker compose up -d postgres redis mailpit`.

## 2. Multi-Tenancy & Isolation Test Suite Requirements
The isolation test suite (`test/tenancy-rls.e2e-spec.ts`) must comprehensively verify the following attack vectors and operational invariants under the non-privileged `progresseye_app` database role:
1. **Cross-Tenant Read Isolation**: Tenant A cannot query or read records belonging to Tenant B via Prisma or raw SQL.
2. **Cross-Tenant Write / Target Tampering**: Tenant A attempting to insert or update rows with `school_id = Tenant B` must fail or be blocked by RLS `WITH CHECK`.
3. **Explicit Cross-Tenant WHERE Clauses**: Queries where a tenant explicitly queries `WHERE school_id = '<other_tenant_id>'` must return empty results.
4. **Missing Tenant Context**: Queries executed with an unset or empty `app.current_school_id` must return 0 rows (fail closed).
5. **Malformed Context Rejection**: Passing non-UUID strings or SQL injection attempts to tenant context setters must be rejected at the validation layer before hitting the database.
6. **FORCE RLS Invariant**: RLS policies apply even when running queries as the table owner.
7. **Direct Partition Access**: Direct queries to underlying monthly partition tables (e.g. `audit_logs_y2026m11`) respect RLS and reject unauthorized cross-tenant rows.
8. **Audit Log Immutability**: Direct `UPDATE` and `DELETE` queries on `audit_logs` fail with permission denied errors under the app role.
9. **Counter Concurrency**: Concurrent increments on `counters` using row locks (`SELECT ... FOR UPDATE`) produce exact sequential numbers without gaps or race conditions.
10. **Clean Migration Deployment**: `prisma migrate deploy` must execute cleanly from scratch on an empty database and upgrade from previous schemas without data corruption.
