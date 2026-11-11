import { execSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
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

  const upgradeDbUrl = `${dbUrlBase}/test_ci_upgrade`;
  const upgradePrisma = new PrismaClient({
    datasources: { db: { url: upgradeDbUrl } },
  });
  await upgradePrisma.$connect();

  // Create _prisma_migrations table
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

  const baselineMigrations = [
    "20261012000000_enable_postgresql_extensions",
    "20261024000000_create_public_leads",
    "20261024010000_add_notified_at_to_leads",
    "20261102000000_tenancy_and_row_level_security",
    "20261108000000_auth_and_session_foundation",
    "20261109000000_account_lifecycle_and_reset_tokens",
  ];

  const migrationsDir = path.resolve(__dirname, "../../prisma/migrations");

  for (const mig of baselineMigrations) {
    const migFile = path.join(migrationsDir, mig, "migration.sql");
    execSync(`pnpm prisma db execute --file "${migFile}" --url "${upgradeDbUrl}"`, {
      encoding: "utf8",
    });

    const checksum = crypto.createHash("sha256").update(fs.readFileSync(migFile)).digest("hex");
    const migId = crypto.randomUUID();
    await upgradePrisma.$executeRawUnsafe(`
      INSERT INTO "_prisma_migrations" ("id", "checksum", "finished_at", "migration_name", "applied_steps_count")
      VALUES ('${migId}', '${checksum}', now(), '${mig}', 1);
    `);
  }

  // Seed sample tenant data across baseline tables
  const sampleSchoolId = "018f0000-0000-7000-8000-000000000001";
  const sampleUserId = "018f0000-0000-7000-8000-000000000002";
  const sampleSessionId = "018f0000-0000-7000-8000-000000000003";
  const sampleFamilyId = "018f0000-0000-7000-8000-000000000004";
  const sampleResetTokenId = "018f0000-0000-7000-8000-000000000005";
  const sampleVerifyTokenId = "018f0000-0000-7000-8000-000000000006";

  await upgradePrisma.$executeRawUnsafe(`
    INSERT INTO schools (id, slug, name, updated_at)
    VALUES ('${sampleSchoolId}'::uuid, 'main-school', 'Main School', CURRENT_TIMESTAMP);
  `);

  await upgradePrisma.$executeRawUnsafe(`
    INSERT INTO users (id, school_id, email, first_name, last_name, password_hash, email_verified_at, updated_at)
    VALUES ('${sampleUserId}'::uuid, '${sampleSchoolId}'::uuid, 'main-user@example.com', 'Main', 'User', 'seeded_hash', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
  `);

  await upgradePrisma.$executeRawUnsafe(`
    INSERT INTO sessions (id, school_id, user_id, refresh_token_hash, family_id, expires_at, created_at, updated_at)
    VALUES ('${sampleSessionId}'::uuid, '${sampleSchoolId}'::uuid, '${sampleUserId}'::uuid, 'seeded_refresh_hash', '${sampleFamilyId}'::uuid, CURRENT_TIMESTAMP + INTERVAL '7 days', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
  `);

  await upgradePrisma.$executeRawUnsafe(`
    INSERT INTO password_reset_tokens (id, school_id, user_id, token_hash, expires_at, created_at)
    VALUES ('${sampleResetTokenId}'::uuid, '${sampleSchoolId}'::uuid, '${sampleUserId}'::uuid, 'seeded_reset_hash', CURRENT_TIMESTAMP + INTERVAL '1 hour', CURRENT_TIMESTAMP);
  `);

  await upgradePrisma.$executeRawUnsafe(`
    INSERT INTO email_verification_tokens (id, school_id, user_id, token_hash, expires_at, created_at)
    VALUES ('${sampleVerifyTokenId}'::uuid, '${sampleSchoolId}'::uuid, '${sampleUserId}'::uuid, 'seeded_verify_hash', CURRENT_TIMESTAMP + INTERVAL '24 hours', CURRENT_TIMESTAMP);
  `);

  console.log("Real main schema (migrations 1-6) applied and sample tenant data seeded.");

  console.log("Running prisma migrate deploy on upgraded database...");
  const upgradeDeployOutput = execSync("pnpm prisma migrate deploy", {
    env: {
      ...process.env,
      DATABASE_URL: upgradeDbUrl,
      DIRECT_URL: upgradeDbUrl,
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
  console.log("Verified pre-existing school preserved after upgrade.");

  const existingUser: any[] = await upgradePrisma.$queryRaw`
    SELECT id, email, is_two_factor_enabled FROM users WHERE id = ${sampleUserId}::uuid;
  `;
  if (existingUser.length !== 1 || existingUser[0].is_two_factor_enabled !== false) {
    throw new Error("Existing user not preserved or is_two_factor_enabled default failed!");
  }
  console.log("Verified pre-existing user preserved and is_two_factor_enabled defaulted to false.");

  const existingSession: any[] = await upgradePrisma.$queryRaw`
    SELECT id, refresh_token_hash FROM sessions WHERE id = ${sampleSessionId}::uuid;
  `;
  if (existingSession.length !== 1) {
    throw new Error("Existing session not preserved after migration deploy!");
  }
  console.log("Verified pre-existing session preserved after upgrade.");

  const existingResetToken: any[] = await upgradePrisma.$queryRaw`
    SELECT id, token_hash FROM password_reset_tokens WHERE id = ${sampleResetTokenId}::uuid;
  `;
  if (existingResetToken.length !== 1) {
    throw new Error("Existing password reset token not preserved after migration deploy!");
  }
  console.log("Verified pre-existing password reset token preserved after upgrade.");

  const existingVerifyToken: any[] = await upgradePrisma.$queryRaw`
    SELECT id, token_hash FROM email_verification_tokens WHERE id = ${sampleVerifyTokenId}::uuid;
  `;
  if (existingVerifyToken.length !== 1) {
    throw new Error("Existing email verification token not preserved after migration deploy!");
  }
  console.log("Verified pre-existing email verification token preserved after upgrade.");

  const totpSecretTable: any[] = await upgradePrisma.$queryRaw`
    SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename = 'user_two_factor_secrets';
  `;
  if (totpSecretTable.length !== 1) {
    throw new Error("Phase 12b-2 user_two_factor_secrets table not found!");
  }

  const recoveryCodeTable: any[] = await upgradePrisma.$queryRaw`
    SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename = 'user_recovery_codes';
  `;
  if (recoveryCodeTable.length !== 1) {
    throw new Error("Phase 12b-2 user_recovery_codes table not found!");
  }
  console.log("Verified Phase 12b-2 TOTP and recovery codes tables deployed successfully.");

  await upgradePrisma.$disconnect();
  await adminPrisma.$disconnect();

  console.log("=== All Migration Deploy Verifications Passed! ===");
}

main().catch((err) => {
  console.error("Migration verification failed:", err);
  process.exit(1);
});
