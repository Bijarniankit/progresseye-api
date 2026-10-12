# ADR-002: PostgreSQL / Supabase with Row-Level Security (RLS)

## Status
Accepted

## Context
ProgressEye is a multi-tenant platform serving schools. School data (students, staff, exams, fees, attendance) is strictly confidential and sensitive. Accidental cross-tenant data leakage is unacceptable. Multi-tenancy must be enforced at the database level rather than relying solely on developers remembering to append `WHERE school_id = ...` in every query.

## Decision
We adopt **Supabase PostgreSQL** with native PostgreSQL Row-Level Security (RLS):
1. **Shared Database, Shared Schema**: All schools reside within the same database schema to optimize operational cost, migration simplicity, and resource pooling.
2. **Mandatory `school_id`**: Every tenant-scoped table has a non-nullable `school_id UUID` column with a composite index starting with `school_id`.
3. **Database RLS Policies**: `ENABLE` and `FORCE ROW LEVEL SECURITY` are executed on every tenant table. Queries are constrained by `school_id = current_setting('app.school_id')::uuid`.
4. **Prisma Client Integration**: Prisma transactions set the session variable `set_config('app.school_id', ..., true)` within the request context using `AsyncLocalStorage`.
5. **Supabase Managed Postgres**: Supabase provides managed PostgreSQL 15/17 hosting, connection pooling (Supavisor / PgBouncer), native RLS enforcement, and backup infrastructure, accessed via standard `DATABASE_URL` and `DIRECT_URL`.
6. **Local Fallback**: Local Docker Compose provides standard PostgreSQL 17 for zero-dependency offline development.

## Consequences
### Positive
- Cross-tenant data leakage is physically prevented by the PostgreSQL kernel, even if an application query omits a filter.
- Support engineers, reporting tools, and direct DB access respect tenant boundaries automatically when running as the app role.
- Managed Supabase infrastructure simplifies connection pooling, point-in-time recovery, and scaling.

### Negative
- Requires careful handling of connection pooling (`set_config(..., true)` must be scoped per transaction).
- Database migrations require elevated privileges (`owner` role) capable of altering tables and policies.
