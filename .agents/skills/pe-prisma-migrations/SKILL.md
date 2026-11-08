---
name: pe-prisma-migrations
description: Guidance and standards for creating, verifying, deploying, and maintaining Prisma migrations and raw SQL schemas in ProgressEye API.
---
# ProgressEye Prisma Migrations Standard

## 1. Migration Philosophy & Forward-Only Deployments
- Migrations in ProgressEye are strictly forward-only. Never mutate, squash, or retroactively edit committed migration files in `prisma/migrations/`.
- Every migration must be idempotent or safe against re-execution where appropriate, adhering to PostgreSQL 17 standards.
- Migration deployment in CI and staging/production runs via `prisma migrate deploy`.

## 2. PostgreSQL RLS & Schema Coexistence
- Prisma Client manages table declarations and relations in `prisma/schema.prisma`.
- Advanced PostgreSQL database constructs (Row Level Security policies, partial unique indexes, table partitioning, database roles, grant matrices) that are not natively expressible in Prisma schema syntax must be placed in forward-only SQL migration files.
- Always run `prisma migrate dev --create-only` or create a timestamped migration directory `prisma/migrations/<YYYYMMDDHHMMSS>_<name>/migration.sql` and verify syntax before applying.

## 3. Soft-Delete Partial Unique Constraints
- When a table is soft-deletable (contains `deleted_at TIMESTAMP(3)`), unique constraints must NOT be standard table-level unique constraints.
- Unique constraints must be declared as partial unique indexes in raw SQL:
  ```sql
  CREATE UNIQUE INDEX "table_column_key" ON "table"("column") WHERE "deleted_at" IS NULL;
  ```
- This prevents soft-deleted rows from colliding with active records.

## 4. Nil-UUID Safeguards
- All tenant identifiers (`school_id`) and tenant entity IDs (`id`) must enforce non-nil UUID check constraints:
  ```sql
  CONSTRAINT "check_<table_name>_not_nil_uuid" CHECK ("id" <> '00000000-0000-0000-0000-000000000000'::uuid)
  ```
- This guarantees fail-closed security when combined with RLS context fallback.
