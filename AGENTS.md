# ProgressEye API — Agent Rules
Stack: NestJS 11, Fastify HTTP adapter, BullMQ worker, Prisma ORM, PostgreSQL with RLS, TypeScript strict, Zod (`nestjs-zod`), `@nestjs/swagger`.

Always
- Work on one phase at a time. Produce an implementation plan first and wait for approval.
- Enforce tenant context (`school_id`) on every database query and tenant table.
- Use repository abstractions: no raw SQL queries outside designated repositories.
- Every HTTP route must declare an explicit permission and guard (e.g., `@RequirePermission(...)`).
- Store and calculate all monetary amounts strictly as integer paise (never floating point).
- Database migrations must follow the expand-then-contract pattern. No breaking column drops without a multi-phase migration.
- Zod DTOs are the single source of truth for request/response validation and OpenAPI specification generation (`/api/v1/openapi.json`).
- Ensure test coverage: test routes as allowed user, denied user, and cross-tenant (other-school) user.
- Before finishing: lint, typecheck, unit/integration tests and build pass cleanly.

Never
- Bypass RLS or omit `school_id` on tenant-scoped operations.
- Put tenant data in public module tables (public tables serve marketing only and have no `school_id`).
- Log PII, passwords, session tokens, or sensitive credentials.
- Store plain passwords (use Argon2id).
- Execute destructive database migrations without an approved Architectural Decision Record (ADR).

Skills: use pe-api-architecture, pe-nest-module, pe-api-contract, pe-queue-jobs, pe-prisma-migrations, pe-tenant-rls, pe-e2e-testing, pe-auth-sessions, pe-security-review, pe-fees-ledger, pe-dpdp-privacy as relevant by phase.
