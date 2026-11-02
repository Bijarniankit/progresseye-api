import * as fs from "node:fs";
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

  describe("1. Cross-Tenant Read Isolation", () => {
    it("should allow Tenant A to read only Tenant A users and academic years", async () => {
      await tenantContext.run({ schoolId: schoolA }, async () => {
        const client = prisma.client;

        // Switch session role to non-privileged application role
        await client.$executeRawUnsafe(`SET ROLE progresseye_app;`);

        const users: any[] = await client.$queryRaw`SELECT id, email, first_name FROM users;`;
        expect(users.length).toBe(1);
        expect(users[0].id).toBe(userAId);
        expect(users[0].email).toBe("user-a@school-a.edu");

        await client.$executeRawUnsafe(`RESET ROLE;`);
      });
    });

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

  describe("2. Cross-Tenant Insert / Target Tampering Isolation", () => {
    it("should block Tenant A from inserting records targeting Tenant B (RLS WITH CHECK)", async () => {
      await tenantContext.run({ schoolId: schoolA }, async () => {
        const client = prisma.client;

        await client.$executeRawUnsafe(`SET ROLE progresseye_app;`);

        const targetTamperedId = uuidv7();
        await expect(
          client.$executeRaw`
            INSERT INTO users (id, school_id, email, first_name, last_name, is_active)
            VALUES (${targetTamperedId}::uuid, ${schoolB}::uuid, 'tampered@school-b.edu', 'Evil', 'Actor', true);
          `,
        ).rejects.toThrow();

        await client.$executeRawUnsafe(`RESET ROLE;`);
      });
    });
  });

  describe("3. Cross-Tenant Update Isolation", () => {
    it("should prevent Tenant A from updating Tenant B records (0 rows affected)", async () => {
      await tenantContext.run({ schoolId: schoolA }, async () => {
        const client = prisma.client;

        await client.$executeRawUnsafe(`SET ROLE progresseye_app;`);

        const affectedCount = await client.$executeRaw`
          UPDATE users SET first_name = 'Hacked' WHERE id = ${userBId}::uuid;
        `;
        expect(affectedCount).toBe(0);

        await client.$executeRawUnsafe(`RESET ROLE;`);
      });

      // Verify Bob was not modified
      const bob: any[] =
        await prisma.$queryRaw`SELECT first_name FROM users WHERE id = ${userBId}::uuid;`;
      expect(bob[0].first_name).toBe("Bob");
    });
  });

  describe("4. Cross-Tenant Delete Isolation", () => {
    it("should prevent Tenant A from deleting Tenant B records (0 rows affected)", async () => {
      await tenantContext.run({ schoolId: schoolA }, async () => {
        const client = prisma.client;

        await client.$executeRawUnsafe(`SET ROLE progresseye_app;`);

        const affectedCount = await client.$executeRaw`
          DELETE FROM users WHERE id = ${userBId}::uuid;
        `;
        expect(affectedCount).toBe(0);

        await client.$executeRawUnsafe(`RESET ROLE;`);
      });

      // Verify Bob still exists
      const bob: any[] = await prisma.$queryRaw`SELECT id FROM users WHERE id = ${userBId}::uuid;`;
      expect(bob.length).toBe(1);
    });
  });

  describe("5. Explicit WHERE Clause Targeting Another Tenant", () => {
    it("should return 0 rows when Tenant A explicitly queries WHERE school_id = Tenant B", async () => {
      await tenantContext.run({ schoolId: schoolA }, async () => {
        const client = prisma.client;

        await client.$executeRawUnsafe(`SET ROLE progresseye_app;`);

        const result: any[] = await client.$queryRaw`
          SELECT * FROM users WHERE school_id = ${schoolB}::uuid;
        `;
        expect(result.length).toBe(0);

        await client.$executeRawUnsafe(`RESET ROLE;`);
      });
    });
  });

  describe("6. Missing Tenant Context (Fail-Closed)", () => {
    it("should return 0 rows for all tenant tables when app.current_school_id is unset", async () => {
      // Execute outside of any tenantContext
      const client = prisma.client;

      await client.$executeRawUnsafe(`SET ROLE progresseye_app;`);
      await client.$executeRawUnsafe(`SELECT set_config('app.current_school_id', '', true);`);

      const users: any[] = await client.$queryRaw`SELECT * FROM users;`;
      expect(users.length).toBe(0);

      const academicYears: any[] = await client.$queryRaw`SELECT * FROM academic_years;`;
      expect(academicYears.length).toBe(0);

      const counters: any[] = await client.$queryRaw`SELECT * FROM counters;`;
      expect(counters.length).toBe(0);

      const auditLogs: any[] = await client.$queryRaw`SELECT * FROM audit_logs;`;
      expect(auditLogs.length).toBe(0);

      await client.$executeRawUnsafe(`RESET ROLE;`);
    });
  });

  describe("7. Malformed Tenant Context Rejection", () => {
    it("should reject invalid non-UUID strings and SQL injection in tenant context", async () => {
      await expect(tenantContext.run({ schoolId: "malformed-id" }, async () => {})).rejects.toThrow(
        BadRequestException,
      );

      await expect(
        tenantContext.run({ schoolId: "'; DROP TABLE users; --" }, async () => {}),
      ).rejects.toThrow(BadRequestException);

      await expect(
        tenantContext.run({ schoolId: "00000000-0000-0000-0000-000000000000" }, async () => {}),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe("8. FORCE RLS vs Table Owner Invariant", () => {
    it("should enforce tenant boundaries even when query runs as progresseye_owner", async () => {
      await tenantContext.run({ schoolId: schoolA }, async () => {
        const client = prisma.client;

        // Switch session role to table owner
        await client.$executeRawUnsafe(`SET ROLE progresseye_owner;`);

        // Because FORCE ROW LEVEL SECURITY is enabled on users, owner only sees School A
        const users: any[] = await client.$queryRaw`SELECT id FROM users;`;
        expect(users.length).toBe(1);
        expect(users[0].id).toBe(userAId);

        await client.$executeRawUnsafe(`RESET ROLE;`);
      });
    });
  });

  describe("9. Partition Direct Access & Audit Log Immutability", () => {
    it("should isolate direct partition queries and reject UPDATE/DELETE under progresseye_app", async () => {
      const logAId = uuidv7();

      // Insert audit log for Tenant A in November 2026 partition
      await tenantContext.run({ schoolId: schoolA }, async () => {
        const client = prisma.client;
        await client.$executeRawUnsafe(`SET ROLE progresseye_app;`);

        await client.$executeRaw`
          INSERT INTO audit_logs (id, school_id, action, resource, created_at)
          VALUES (${logAId}::uuid, ${schoolA}::uuid, 'USER_LOGIN', 'users', '2026-11-02 10:00:00'::timestamp);
        `;

        // Direct SELECT on partition returns log
        const logs: any[] = await client.$queryRaw`
          SELECT id, action FROM audit_logs_y2026m11;
        `;
        expect(logs.length).toBe(1);
        expect(logs[0].id).toBe(logAId);

        // Attempt direct UPDATE on partition under progresseye_app - MUST FAIL (permission denied)
        await expect(
          client.$executeRaw`UPDATE audit_logs_y2026m11 SET action = 'ALTERED';`,
        ).rejects.toThrow();

        // Attempt direct DELETE on partition under progresseye_app - MUST FAIL (permission denied)
        await expect(client.$executeRaw`DELETE FROM audit_logs_y2026m11;`).rejects.toThrow();

        await client.$executeRawUnsafe(`RESET ROLE;`);
      });

      // Tenant B direct partition query returns 0 rows
      await tenantContext.run({ schoolId: schoolB }, async () => {
        const client = prisma.client;
        await client.$executeRawUnsafe(`SET ROLE progresseye_app;`);

        const logs: any[] = await client.$queryRaw`
          SELECT id FROM audit_logs_y2026m11;
        `;
        expect(logs.length).toBe(0);

        await client.$executeRawUnsafe(`RESET ROLE;`);
      });
    });
  });

  describe("10. Counter Concurrency with Row Locks", () => {
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

  describe("11. Migration Deploy from Empty and from Current Main", () => {
    const dbUrlBase =
      process.env.DATABASE_URL?.substring(0, process.env.DATABASE_URL.lastIndexOf("/")) ??
      "postgresql://postgres:postgrespassword@localhost:5432";

    it("should deploy cleanly from empty database", async () => {
      await prisma.$executeRawUnsafe(`DROP DATABASE IF EXISTS test_db_empty;`);
      await prisma.$executeRawUnsafe(`CREATE DATABASE test_db_empty;`);

      const emptyPrisma = new PrismaClient({
        datasources: { db: { url: `${dbUrlBase}/test_db_empty` } },
      });
      await emptyPrisma.$connect();

      const m1 = fs.readFileSync(
        "prisma/migrations/20261012000000_enable_postgresql_extensions/migration.sql",
        "utf8",
      );
      const m2 = fs.readFileSync(
        "prisma/migrations/20261024000000_create_public_leads/migration.sql",
        "utf8",
      );
      const m3 = fs.readFileSync(
        "prisma/migrations/20261024010000_add_notified_at_to_leads/migration.sql",
        "utf8",
      );
      const m4 = fs.readFileSync(
        "prisma/migrations/20261102000000_tenancy_and_row_level_security/migration.sql",
        "utf8",
      );

      await emptyPrisma.$executeRawUnsafe(m1);
      await emptyPrisma.$executeRawUnsafe(m2);
      await emptyPrisma.$executeRawUnsafe(m3);
      await emptyPrisma.$executeRawUnsafe(m4);

      const tables: any[] = await emptyPrisma.$queryRaw`
        SELECT tablename FROM pg_tables WHERE schemaname = 'public';
      `;
      const tableNames = tables.map((t) => t.tablename);
      expect(tableNames).toContain("schools");
      expect(tableNames).toContain("users");
      expect(tableNames).toContain("audit_logs");
      expect(tableNames).toContain("counters");

      await emptyPrisma.$disconnect();
    });

    it("should deploy cleanly from current main schema upgrade", async () => {
      await prisma.$executeRawUnsafe(`DROP DATABASE IF EXISTS test_db_from_main;`);
      await prisma.$executeRawUnsafe(`CREATE DATABASE test_db_from_main;`);

      const mainPrisma = new PrismaClient({
        datasources: { db: { url: `${dbUrlBase}/test_db_from_main` } },
      });
      await mainPrisma.$connect();

      // Apply main migrations (1, 2, 3)
      const m1 = fs.readFileSync(
        "prisma/migrations/20261012000000_enable_postgresql_extensions/migration.sql",
        "utf8",
      );
      const m2 = fs.readFileSync(
        "prisma/migrations/20261024000000_create_public_leads/migration.sql",
        "utf8",
      );
      const m3 = fs.readFileSync(
        "prisma/migrations/20261024010000_add_notified_at_to_leads/migration.sql",
        "utf8",
      );
      await mainPrisma.$executeRawUnsafe(m1);
      await mainPrisma.$executeRawUnsafe(m2);
      await mainPrisma.$executeRawUnsafe(m3);

      // Insert existing main data (school without org, public leads)
      await mainPrisma.$executeRawUnsafe(`
        INSERT INTO schools (id, slug, name, updated_at) VALUES ('018f0000-0000-7000-8000-000000000001'::uuid, 'main-school', 'Main School', CURRENT_TIMESTAMP);
      `);

      // Apply Phase 11 upgrade migration
      const m4 = fs.readFileSync(
        "prisma/migrations/20261102000000_tenancy_and_row_level_security/migration.sql",
        "utf8",
      );
      await mainPrisma.$executeRawUnsafe(m4);

      // Verify existing data preserved and new schema active
      const school: any[] = await mainPrisma.$queryRaw`
        SELECT slug, name, is_active FROM schools WHERE slug = 'main-school';
      `;
      expect(school.length).toBe(1);
      expect(school[0].name).toBe("Main School");
      expect(school[0].is_active).toBe(true);

      await mainPrisma.$disconnect();
    });
  });
});
