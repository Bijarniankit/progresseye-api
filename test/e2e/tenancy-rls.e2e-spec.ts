import { execSync } from "node:child_process";
import { BadRequestException } from "@nestjs/common";
import { PrismaClient } from "@prisma/client";
import { uuidv7 } from "uuidv7";
import { TenantContextService } from "../../src/common/request-context/tenant-context.service";
import { PrismaService } from "../../src/infra/prisma/prisma.service";

describe("Phase 11: Tenancy & Row-Level Security (RLS) Isolation Suite", () => {
  let prisma: PrismaService;
  let tenantContext: TenantContextService;

  const schoolA = uuidv7();
  const schoolB = uuidv7();
  const orgId = uuidv7();

  const userAId = uuidv7();
  const userBId = uuidv7();

  const dbUrlStr =
    process.env.DATABASE_URL ?? "postgresql://postgres:postgrespassword@localhost:5432/test_db";
  const urlObj = new URL(dbUrlStr);
  const host = urlObj.hostname;
  const port = urlObj.port || "5432";
  const dbName = urlObj.pathname.replace(/^\//, "");

  const appDbUrl = `postgresql://progresseye_app:apppassword@${host}:${port}/${dbName}`;
  const ownerDbUrl = `postgresql://progresseye_owner:ownerpassword@${host}:${port}/${dbName}`;

  beforeAll(async () => {
    tenantContext = new TenantContextService();
    prisma = new PrismaService(tenantContext);
    await prisma.$connect();

    // Clean up any existing test entities
    await prisma.$executeRawUnsafe(
      `TRUNCATE TABLE organizations, schools, academic_years, users, sessions, roles, permissions, role_permissions, user_roles, audit_logs, outbox_events, counters CASCADE;`,
    );

    // Setup base organization and schools as migration owner/admin
    await prisma.$executeRaw`
      INSERT INTO organizations (id, name, slug)
      VALUES (${orgId}::uuid, 'Test Trust', 'test-trust');
    `;

    await prisma.$executeRaw`
      INSERT INTO schools (id, organization_id, slug, name, is_active, updated_at)
      VALUES 
        (${schoolA}::uuid, ${orgId}::uuid, 'school-a', 'School Alpha', true, CURRENT_TIMESTAMP),
        (${schoolB}::uuid, ${orgId}::uuid, 'school-b', 'School Beta', true, CURRENT_TIMESTAMP);
    `;

    // Seed test users
    await prisma.$executeRaw`
      INSERT INTO users (id, school_id, email, first_name, last_name, is_active)
      VALUES 
        (${userAId}::uuid, ${schoolA}::uuid, 'user-a@school-a.edu', 'Alice', 'Alpha', true),
        (${userBId}::uuid, ${schoolB}::uuid, 'user-b@school-b.edu', 'Bob', 'Beta', true);
    `;
  });

  afterAll(async () => {
    await prisma.$executeRawUnsafe(`RESET ROLE;`);
    await prisma.$disconnect();
  });

  describe("Test 01: Cross-Tenant Read Isolation (Tenant A)", () => {
    it("should allow Tenant A to read only Tenant A users and academic years", async () => {
      await tenantContext.run({ schoolId: schoolA }, async () => {
        const client = prisma.client;
        await client.$executeRawUnsafe(`SET ROLE progresseye_app;`);

        const users: any[] = await client.$queryRaw`SELECT id, email, first_name FROM users;`;
        expect(users.length).toBe(1);
        expect(users[0].id).toBe(userAId);
        expect(users[0].email).toBe("user-a@school-a.edu");

        await client.$executeRawUnsafe(`RESET ROLE;`);
      });
    });
  });

  describe("Test 02: Cross-Tenant Read Isolation (Tenant B)", () => {
    it("should allow Tenant B to read only Tenant B users", async () => {
      await tenantContext.run({ schoolId: schoolB }, async () => {
        const client = prisma.client;
        await client.$executeRawUnsafe(`SET ROLE progresseye_app;`);

        const users: any[] = await client.$queryRaw`SELECT id, email, first_name FROM users;`;
        expect(users.length).toBe(1);
        expect(users[0].id).toBe(userBId);
        expect(users[0].email).toBe("user-b@school-b.edu");

        await client.$executeRawUnsafe(`RESET ROLE;`);
      });
    });
  });

  describe("Test 03: Cross-Tenant Insert Protection", () => {
    it("should block Tenant A from inserting records targeting Tenant B (RLS WITH CHECK)", async () => {
      const maliciousUserId = uuidv7();
      await tenantContext.run({ schoolId: schoolA }, async () => {
        const client = prisma.client;
        await client.$executeRawUnsafe(`SET ROLE progresseye_app;`);

        await expect(
          client.$executeRaw`
            INSERT INTO users (id, school_id, email, first_name, last_name)
            VALUES (${maliciousUserId}::uuid, ${schoolB}::uuid, 'intruder@school-b.edu', 'Eve', 'Intruder');
          `,
        ).rejects.toThrow();

        await client.$executeRawUnsafe(`RESET ROLE;`);
      });
    });
  });

  describe("Test 04: Cross-Tenant Update Protection", () => {
    it("should prevent Tenant A from updating Tenant B records (0 rows affected)", async () => {
      await tenantContext.run({ schoolId: schoolA }, async () => {
        const client = prisma.client;
        await client.$executeRawUnsafe(`SET ROLE progresseye_app;`);

        const updatedCount = await client.$executeRaw`
          UPDATE users
          SET first_name = 'Hacked'
          WHERE id = ${userBId}::uuid;
        `;
        expect(updatedCount).toBe(0);

        await client.$executeRawUnsafe(`RESET ROLE;`);
      });
    });
  });

  describe("Test 05: Cross-Tenant Delete Protection", () => {
    it("should prevent Tenant A from deleting Tenant B records (0 rows affected)", async () => {
      await tenantContext.run({ schoolId: schoolA }, async () => {
        const client = prisma.client;
        await client.$executeRawUnsafe(`SET ROLE progresseye_app;`);

        const deletedCount = await client.$executeRaw`
          DELETE FROM users
          WHERE id = ${userBId}::uuid;
        `;
        expect(deletedCount).toBe(0);

        await client.$executeRawUnsafe(`RESET ROLE;`);
      });
    });
  });

  describe("Test 06: Explicit WHERE Clause Targeting Another Tenant", () => {
    it("should return 0 rows when Tenant A explicitly queries WHERE school_id = Tenant B", async () => {
      await tenantContext.run({ schoolId: schoolA }, async () => {
        const client = prisma.client;
        await client.$executeRawUnsafe(`SET ROLE progresseye_app;`);

        const rows: any[] = await client.$queryRaw`
          SELECT id FROM users WHERE school_id = ${schoolB}::uuid;
        `;
        expect(rows.length).toBe(0);

        await client.$executeRawUnsafe(`RESET ROLE;`);
      });
    });
  });

  describe("Test 07: Missing Tenant Context (Fail-Closed)", () => {
    it("should return 0 rows for all tenant tables when app.current_school_id is unset", async () => {
      const client = prisma.client;
      await client.$executeRawUnsafe(`SET ROLE progresseye_app;`);
      await client.$executeRawUnsafe(`SELECT set_config('app.current_school_id', '', true);`);

      const users: any[] = await client.$queryRaw`SELECT id FROM users;`;
      expect(users.length).toBe(0);

      const academicYears: any[] = await client.$queryRaw`SELECT id FROM academic_years;`;
      expect(academicYears.length).toBe(0);

      const sessions: any[] = await client.$queryRaw`SELECT id FROM sessions;`;
      expect(sessions.length).toBe(0);

      const auditLogs: any[] = await client.$queryRaw`SELECT id FROM audit_logs;`;
      expect(auditLogs.length).toBe(0);

      await client.$executeRawUnsafe(`RESET ROLE;`);
    });
  });

  describe("Test 08: Malformed Tenant Context Rejection", () => {
    it("should reject invalid non-UUID strings and SQL injection in tenant context", async () => {
      await expect(
        tenantContext.run({ schoolId: "invalid-uuid-format" }, async () => {}),
      ).rejects.toThrow(BadRequestException);

      await expect(
        tenantContext.run({ schoolId: "'; DROP TABLE users; --" }, async () => {}),
      ).rejects.toThrow(BadRequestException);

      await expect(
        tenantContext.run({ schoolId: "00000000-0000-0000-0000-000000000000" }, async () => {}),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe("Test 09: FORCE RLS vs Table Owner Invariant (Non-Superuser Direct Connection)", () => {
    it("should enforce tenant boundaries even when connected directly as progresseye_owner", async () => {
      const ownerPrisma = new PrismaClient({
        datasources: { db: { url: ownerDbUrl } },
      });
      await ownerPrisma.$connect();

      // Assert that progresseye_owner is NOT superuser and does NOT have BYPASSRLS
      const [roleInfo]: any[] = await ownerPrisma.$queryRaw`
        SELECT rolname, rolsuper, rolbypassrls, rolcanlogin 
        FROM pg_roles 
        WHERE rolname = 'progresseye_owner';
      `;
      expect(roleInfo.rolsuper).toBe(false);
      expect(roleInfo.rolbypassrls).toBe(false);
      expect(roleInfo.rolcanlogin).toBe(true);

      // Query with Tenant A context: sees only Tenant A
      await ownerPrisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.current_school_id', ${schoolA}, true);`;
        const usersA: any[] = await tx.$queryRaw`SELECT id FROM users;`;
        expect(usersA.length).toBe(1);
        expect(usersA[0].id).toBe(userAId);
      });

      // Query with Tenant B context: sees only Tenant B
      await ownerPrisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.current_school_id', ${schoolB}, true);`;
        const usersB: any[] = await tx.$queryRaw`SELECT id FROM users;`;
        expect(usersB.length).toBe(1);
        expect(usersB[0].id).toBe(userBId);
      });

      // Query with empty context: returns 0 rows (FORCE RLS enforces fail-closed against owner)
      await ownerPrisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.current_school_id', '', true);`;
        const usersEmpty: any[] = await tx.$queryRaw`SELECT id FROM users;`;
        expect(usersEmpty.length).toBe(0);
      });

      await ownerPrisma.$disconnect();
    });
  });

  describe("Test 10: Partition Direct Access & Audit Log Immutability", () => {
    it("should isolate direct partition queries and reject UPDATE/DELETE under progresseye_app", async () => {
      const appPrisma = new PrismaClient({
        datasources: { db: { url: appDbUrl } },
      });
      await appPrisma.$connect();

      const [roleInfo]: any[] = await appPrisma.$queryRaw`
        SELECT rolname, rolsuper, rolbypassrls, rolcanlogin 
        FROM pg_roles 
        WHERE rolname = 'progresseye_app';
      `;
      expect(roleInfo.rolsuper).toBe(false);
      expect(roleInfo.rolbypassrls).toBe(false);
      expect(roleInfo.rolcanlogin).toBe(true);

      const logAId = uuidv7();

      // Insert audit log for Tenant A in November 2026 partition
      await appPrisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.current_school_id', ${schoolA}, true);`;
        await tx.$executeRaw`
          INSERT INTO audit_logs (id, school_id, action, resource, created_at)
          VALUES (${logAId}::uuid, ${schoolA}::uuid, 'USER_LOGIN', 'users', '2026-11-02 10:00:00'::timestamp);
        `;

        // Direct SELECT on partition returns log
        const logsA: any[] = await tx.$queryRaw`
          SELECT id, action FROM audit_logs_y2026m11;
        `;
        expect(logsA.length).toBe(1);
        expect(logsA[0].id).toBe(logAId);

        // Attempt direct UPDATE on partition under progresseye_app - MUST FAIL (code 42501 permission denied)
        await expect(
          tx.$executeRaw`UPDATE audit_logs_y2026m11 SET action = 'ALTERED';`,
        ).rejects.toThrow();

        // Attempt direct DELETE on partition under progresseye_app - MUST FAIL (code 42501 permission denied)
        await expect(tx.$executeRaw`DELETE FROM audit_logs_y2026m11;`).rejects.toThrow();
      });

      // Tenant B direct partition query returns 0 rows
      await appPrisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.current_school_id', ${schoolB}, true);`;
        const logsB: any[] = await tx.$queryRaw`
          SELECT id FROM audit_logs_y2026m11;
        `;
        expect(logsB.length).toBe(0);
      });

      await appPrisma.$disconnect();
    });
  });

  describe("Test 11: Audit Log Default Partition for Future Months (2027-02 Insert)", () => {
    it("should route inserts dated 2027-02 into audit_logs_default with RLS and immutability intact", async () => {
      const appPrisma = new PrismaClient({
        datasources: { db: { url: appDbUrl } },
      });
      await appPrisma.$connect();

      const futureLogId = uuidv7();

      // Insert audit log dated 2027-02-15 (beyond the 2027-01 monthly partition)
      await appPrisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.current_school_id', ${schoolA}, true);`;
        await tx.$executeRaw`
          INSERT INTO audit_logs (id, school_id, action, resource, created_at)
          VALUES (${futureLogId}::uuid, ${schoolA}::uuid, 'FUTURE_EVENT', 'audit_default', '2027-02-15 10:00:00'::timestamp);
        `;

        // Direct SELECT on audit_logs_default returns the log for School A
        const logsDefaultA: any[] = await tx.$queryRaw`
          SELECT id, action FROM audit_logs_default WHERE id = ${futureLogId}::uuid;
        `;
        expect(logsDefaultA.length).toBe(1);
        expect(logsDefaultA[0].id).toBe(futureLogId);
      });

      // Direct SELECT on audit_logs_default for School B returns 0 rows (RLS enforced)
      await appPrisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.current_school_id', ${schoolB}, true);`;
        const logsDefaultB: any[] = await tx.$queryRaw`
          SELECT id FROM audit_logs_default WHERE id = ${futureLogId}::uuid;
        `;
        expect(logsDefaultB.length).toBe(0);

        // Attempt UPDATE/DELETE on audit_logs_default under progresseye_app fails (permission denied)
        await expect(
          tx.$executeRaw`UPDATE audit_logs_default SET action = 'MUTATED';`,
        ).rejects.toThrow();
        await expect(
          tx.$executeRaw`DELETE FROM audit_logs_default WHERE id = ${futureLogId}::uuid;`,
        ).rejects.toThrow();
      });

      await appPrisma.$disconnect();
    });
  });

  describe("Test 12: Service Call Under App Role & Concurrent Tenant Isolation", () => {
    it("should isolate pooled client service calls and concurrent requests across tenants", async () => {
      const appPrisma = new PrismaClient({
        datasources: { db: { url: appDbUrl } },
      });
      await appPrisma.$connect();

      // Tenant extension replicating PrismaService on appPrisma
      const appClient = appPrisma.$extends({
        query: {
          $allModels: {
            async $allOperations({ model, operation, args, query }) {
              const schoolId = tenantContext.getTenantId();
              if (!schoolId) {
                return query(args);
              }
              return (appPrisma as any).$transaction(async (tx: any) => {
                await tx.$executeRaw`SELECT set_config('app.current_school_id', ${schoolId}, true)`;
                const modelKey = model.charAt(0).toLowerCase() + model.slice(1);
                return (tx[modelKey] ?? tx[model])[operation](args);
              });
            },
          },
        },
      });

      // 1. Normal service call for Tenant A returns ONLY Tenant A rows
      await tenantContext.run({ schoolId: schoolA }, async () => {
        const users = await (appClient as any).user.findMany();
        expect(users.length).toBe(1);
        expect(users[0].id).toBe(userAId);
        expect(users[0].schoolId).toBe(schoolA);
      });

      // 2. Normal service call for Tenant B returns ONLY Tenant B rows
      await tenantContext.run({ schoolId: schoolB }, async () => {
        const users = await (appClient as any).user.findMany();
        expect(users.length).toBe(1);
        expect(users[0].id).toBe(userBId);
        expect(users[0].schoolId).toBe(schoolB);
      });

      // 3. Concurrent requests on pooled client never cross-contaminate
      const tasks = [
        ...Array.from({ length: 10 }).map(() =>
          tenantContext.run({ schoolId: schoolA }, async () => {
            const users = await (appClient as any).user.findMany();
            expect(users.length).toBe(1);
            expect(users[0].id).toBe(userAId);
            return users[0].id;
          }),
        ),
        ...Array.from({ length: 10 }).map(() =>
          tenantContext.run({ schoolId: schoolB }, async () => {
            const users = await (appClient as any).user.findMany();
            expect(users.length).toBe(1);
            expect(users[0].id).toBe(userBId);
            return users[0].id;
          }),
        ),
      ];

      const results = await Promise.all(tasks);
      expect(results.filter((id) => id === userAId).length).toBe(10);
      expect(results.filter((id) => id === userBId).length).toBe(10);

      await appPrisma.$disconnect();
    });
  });

  describe("Test 13: Counter Sequential Numbering Concurrency", () => {
    it("should handle concurrent increments sequentially with FOR UPDATE row locks", async () => {
      const counterId = uuidv7();

      // Initialize counter for school A
      await prisma.$executeRaw`
        INSERT INTO counters (id, school_id, sequence_name, current_value)
        VALUES (${counterId}::uuid, ${schoolA}::uuid, 'INVOICE_SEQ', 0);
      `;

      // Run 10 concurrent increments using SELECT ... FOR UPDATE
      const concurrency = 10;
      const tasks = Array.from({ length: concurrency }).map(() =>
        tenantContext.run({ schoolId: schoolA }, async () => {
          return prisma.$transaction(async (tx) => {
            await tx.$executeRaw`SELECT set_config('app.current_school_id', ${schoolA}, true);`;
            const [row]: any[] = await tx.$queryRaw`
              SELECT current_value FROM counters
              WHERE school_id = ${schoolA}::uuid AND sequence_name = 'INVOICE_SEQ'
              FOR UPDATE;
            `;
            const nextValue = Number(row.current_value) + 1;
            await tx.$executeRaw`
              UPDATE counters
              SET current_value = ${nextValue}
              WHERE school_id = ${schoolA}::uuid AND sequence_name = 'INVOICE_SEQ';
            `;
            return nextValue;
          });
        }),
      );

      const results = await Promise.all(tasks);
      const sortedResults = results.sort((a, b) => a - b);

      // Verify exact sequence 1..10 without gaps or duplicates
      expect(sortedResults).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    });
  });

  describe("Test 14: Migration Deploy from Empty Database", () => {
    const dbUrlBase =
      process.env.DATABASE_URL?.substring(0, process.env.DATABASE_URL.lastIndexOf("/")) ??
      "postgresql://postgres:postgrespassword@localhost:5432";

    it("should deploy cleanly from empty database using prisma migrate deploy", async () => {
      await prisma.$executeRawUnsafe(`DROP DATABASE IF EXISTS test_db_empty;`);
      await prisma.$executeRawUnsafe(`CREATE DATABASE test_db_empty;`);

      execSync("pnpm prisma migrate deploy", {
        env: {
          ...process.env,
          DATABASE_URL: `${dbUrlBase}/test_db_empty`,
          DIRECT_URL: `${dbUrlBase}/test_db_empty`,
        },
        stdio: "pipe",
      });

      const emptyPrisma = new PrismaClient({
        datasources: { db: { url: `${dbUrlBase}/test_db_empty` } },
      });
      await emptyPrisma.$connect();

      const tables: any[] = await emptyPrisma.$queryRaw`
        SELECT tablename FROM pg_tables WHERE schemaname = 'public';
      `;
      expect(tables.length).toBeGreaterThanOrEqual(13);

      await emptyPrisma.$disconnect();
    });
  });

  describe("Test 15: Migration Deploy from Current Main Schema Upgrade", () => {
    const dbUrlBase =
      process.env.DATABASE_URL?.substring(0, process.env.DATABASE_URL.lastIndexOf("/")) ??
      "postgresql://postgres:postgrespassword@localhost:5432";

    it("should deploy cleanly from current main schema upgrade", async () => {
      await prisma.$executeRawUnsafe(`DROP DATABASE IF EXISTS test_db_from_main;`);
      await prisma.$executeRawUnsafe(`CREATE DATABASE test_db_from_main;`);

      const mainPrisma = new PrismaClient({
        datasources: { db: { url: `${dbUrlBase}/test_db_from_main` } },
      });
      await mainPrisma.$connect();

      // Apply main migrations 1, 2, 3 statement by statement
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
        await mainPrisma.$executeRawUnsafe(stmt);
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
        await mainPrisma.$executeRawUnsafe(stmt);
      }

      const statementsM3 = [
        `ALTER TABLE "public_leads" ADD COLUMN IF NOT EXISTS "notified_at" TIMESTAMP(3);`,
      ];
      for (const stmt of statementsM3) {
        await mainPrisma.$executeRawUnsafe(stmt);
      }

      // Insert pre-existing school on main
      await mainPrisma.$executeRawUnsafe(`
        INSERT INTO schools (id, slug, name, updated_at) VALUES ('018f0000-0000-7000-8000-000000000001'::uuid, 'main-school', 'Main School', CURRENT_TIMESTAMP);
      `);

      // Initialize prisma migrations table so migrate deploy knows 1, 2, 3 were applied
      await mainPrisma.$executeRawUnsafe(`
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
      await mainPrisma.$executeRawUnsafe(`
        INSERT INTO "_prisma_migrations" (id, checksum, finished_at, migration_name, applied_steps_count)
        VALUES 
          ('1', 'checksum1', now(), '20261012000000_enable_postgresql_extensions', 1),
          ('2', 'checksum2', now(), '20261024000000_create_public_leads', 1),
          ('3', 'checksum3', now(), '20261024010000_add_notified_at_to_leads', 1);
      `);

      // Run prisma migrate deploy to apply Phase 11 upgrade migration
      execSync("pnpm prisma migrate deploy", {
        env: {
          ...process.env,
          DATABASE_URL: `${dbUrlBase}/test_db_from_main`,
          DIRECT_URL: `${dbUrlBase}/test_db_from_main`,
        },
        stdio: "pipe",
      });

      // Verify existing data preserved and new schema active
      const school: any[] = await mainPrisma.$queryRaw`
        SELECT id, slug, name FROM schools WHERE slug = 'main-school';
      `;
      expect(school.length).toBe(1);
      expect(school[0].name).toBe("Main School");

      await mainPrisma.$disconnect();
    });
  });
});
