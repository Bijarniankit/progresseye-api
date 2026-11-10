import { execSync } from "node:child_process";
import { PrismaClient } from "@prisma/client";

async function main() {
  const dbUrlBase =
    process.env.DATABASE_URL?.substring(0, process.env.DATABASE_URL.lastIndexOf("/")) ??
    "postgresql://postgres@localhost:5432";

  console.log("=== 1. Testing Migration Deploy from Empty Database ===");
  const adminPrisma = new PrismaClient({
    datasources: { db: { url: `${dbUrlBase}/postgres` } },
  });
  await adminPrisma.$connect();

  await adminPrisma.$executeRawUnsafe(`DROP DATABASE IF EXISTS test_ci_empty;`);
  await adminPrisma.$executeRawUnsafe(`CREATE DATABASE test_ci_empty;`);
  console.log("Created test_ci_empty database.");

  const emptyDeployOutput = execSync("pnpm prisma migrate deploy", {
    env: {
      ...process.env,
      DATABASE_URL: `${dbUrlBase}/test_ci_empty`,
      DIRECT_URL: `${dbUrlBase}/test_ci_empty`,
    },
    encoding: "utf8",
  });
  console.log(emptyDeployOutput);

  const emptyPrisma = new PrismaClient({
    datasources: { db: { url: `${dbUrlBase}/test_ci_empty` } },
  });
  await emptyPrisma.$connect();

  const emptyTables: any[] = await emptyPrisma.$queryRaw`
    SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename;
  `;
  console.log(`Verified ${emptyTables.length} tables deployed in empty database.`);
  await emptyPrisma.$disconnect();

  console.log("\n=== 2. Testing Migration Deploy from Main Schema Upgrade ===");
  await adminPrisma.$executeRawUnsafe(`DROP DATABASE IF EXISTS test_ci_upgrade;`);
  await adminPrisma.$executeRawUnsafe(`CREATE DATABASE test_ci_upgrade;`);
  console.log("Created test_ci_upgrade database.");

  const upgradePrisma = new PrismaClient({
    datasources: { db: { url: `${dbUrlBase}/test_ci_upgrade` } },
  });
  await upgradePrisma.$connect();

  // Apply main migrations 1, 2, 3
  const statementsM1 = [
    `CREATE EXTENSION IF NOT EXISTS "pgcrypto";`,
    `CREATE EXTENSION IF NOT EXISTS "pg_trgm";`,
    `CREATE EXTENSION IF NOT EXISTS "btree_gist";`,
    `CREATE EXTENSION IF NOT EXISTS "citext";`,
    `CREATE TABLE IF NOT EXISTS "schools" (
        "id" UUID NOT NULL DEFAULT gen_random_uuid(),
        "slug" TEXT NOT NULL,
        "name" TEXT NOT NULL,
        "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT "schools_pkey" PRIMARY KEY ("id")
    );`,
    `CREATE UNIQUE INDEX IF NOT EXISTS "schools_slug_key" ON "schools"("slug");`,
  ];
  for (const stmt of statementsM1) {
    await upgradePrisma.$executeRawUnsafe(stmt);
  }

  const statementsM2 = [
    `CREATE TYPE "lead_types" AS ENUM ('CONTACT', 'DEMO', 'NEWSLETTER');`,
    `CREATE TYPE "lead_statuses" AS ENUM ('NEW', 'CONTACTED', 'ARCHIVED');`,
    `CREATE TABLE IF NOT EXISTS "public_leads" (
        "id" UUID NOT NULL DEFAULT gen_random_uuid(),
        "type" "lead_types" NOT NULL,
        "name" TEXT,
        "email" citext NOT NULL,
        "school_name" TEXT,
        "message" TEXT,
        "status" "lead_statuses" NOT NULL DEFAULT 'NEW',
        "consent_text" TEXT NOT NULL,
        "consented_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "ip_address_hash" TEXT,
        "user_agent" TEXT,
        "idempotency_key" TEXT,
        "retention_until" TIMESTAMP(3),
        "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT "public_leads_pkey" PRIMARY KEY ("id")
    );`,
    `CREATE UNIQUE INDEX IF NOT EXISTS "public_leads_idempotency_key_key" ON "public_leads"("idempotency_key");`,
    `CREATE INDEX IF NOT EXISTS "public_leads_type_created_at_idx" ON "public_leads"("type", "created_at");`,
    `CREATE INDEX IF NOT EXISTS "public_leads_email_idx" ON "public_leads"("email");`,
    `CREATE INDEX IF NOT EXISTS "public_leads_status_idx" ON "public_leads"("status");`,
  ];
  for (const stmt of statementsM2) {
    await upgradePrisma.$executeRawUnsafe(stmt);
  }

  const statementsM3 = [
    `ALTER TABLE "public_leads" ADD COLUMN IF NOT EXISTS "notified_at" TIMESTAMP(3);`,
  ];
  for (const stmt of statementsM3) {
    await upgradePrisma.$executeRawUnsafe(stmt);
  }

  // Insert existing data on main
  await upgradePrisma.$executeRawUnsafe(`
    INSERT INTO schools (id, slug, name, updated_at) VALUES ('018f0000-0000-7000-8000-000000000001'::uuid, 'main-school', 'Main School', CURRENT_TIMESTAMP);
  `);
  console.log("Main schema created and sample data seeded.");

  // Record main migrations in _prisma_migrations
  await upgradePrisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "_prisma_migrations" (
      "id" VARCHAR(36) PRIMARY KEY,
      "checksum" VARCHAR(64) NOT NULL,
      "finished_at" TIMESTAMPTZ,
      "migration_name" VARCHAR(255) NOT NULL,
      "logs" TEXT,
      "rolled_back_at" TIMESTAMPTZ,
      "started_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
      "applied_steps_count" INTEGER NOT NULL DEFAULT 0
    );
  `);
  await upgradePrisma.$executeRawUnsafe(`
    INSERT INTO "_prisma_migrations" (id, checksum, finished_at, migration_name, applied_steps_count)
    VALUES 
      ('1', 'c1', now(), '20261012000000_enable_postgresql_extensions', 1),
      ('2', 'c2', now(), '20261024000000_create_public_leads', 1),
      ('3', 'c3', now(), '20261024010000_add_notified_at_to_leads', 1);
  `);

  console.log("Running prisma migrate deploy on upgraded database...");
  const upgradeDeployOutput = execSync("pnpm prisma migrate deploy", {
    env: {
      ...process.env,
      DATABASE_URL: `${dbUrlBase}/test_ci_upgrade`,
      DIRECT_URL: `${dbUrlBase}/test_ci_upgrade`,
    },
    encoding: "utf8",
  });
  console.log(upgradeDeployOutput);

  const existingSchool: any[] = await upgradePrisma.$queryRaw`
    SELECT id, slug, name FROM schools WHERE slug = 'main-school';
  `;
  if (existingSchool.length !== 1) {
    throw new Error("Existing school not preserved after migration deploy!");
  }
  console.log("Verified pre-existing data preserved after Phase 11 upgrade.");

  const sessionCols: any[] = await upgradePrisma.$queryRaw`
    SELECT column_name FROM information_schema.columns 
    WHERE table_name = 'sessions' AND column_name = 'family_id';
  `;
  if (sessionCols.length !== 1) {
    throw new Error("Phase 12a family_id column not found on sessions table!");
  }
  console.log("Verified Phase 12a session family column deployed successfully.");

  const resetTokenTable: any[] = await upgradePrisma.$queryRaw`
    SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename = 'password_reset_tokens';
  `;
  if (resetTokenTable.length !== 1) {
    throw new Error("Phase 12b-1 password_reset_tokens table not found!");
  }

  const verifyTokenTable: any[] = await upgradePrisma.$queryRaw`
    SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename = 'email_verification_tokens';
  `;
  if (verifyTokenTable.length !== 1) {
    throw new Error("Phase 12b-1 email_verification_tokens table not found!");
  }

  const userEmailVerifiedCol: any[] = await upgradePrisma.$queryRaw`
    SELECT column_name FROM information_schema.columns 
    WHERE table_name = 'users' AND column_name = 'email_verified_at';
  `;
  if (userEmailVerifiedCol.length !== 1) {
    throw new Error("Phase 12b-1 email_verified_at column on users table not found!");
  }
  console.log("Verified Phase 12b-1 account lifecycle tables and columns deployed successfully.");

  await upgradePrisma.$disconnect();
  await adminPrisma.$disconnect();

  console.log("=== All Migration Deploy Verifications Passed! ===");
}

main().catch((err) => {
  console.error("Migration verification failed:", err);
  process.exit(1);
});
