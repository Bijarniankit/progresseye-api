import { execSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
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

  const dbUrlStr = process.env.DATABASE_URL ?? "postgresql://postgres@localhost:5432/test_db";
  const urlObj = new URL(dbUrlStr);
  const host = urlObj.hostname;
  const port = urlObj.port || "5432";
  const dbName = urlObj.pathname.replace(/^\//, "");

  const appSecret = process.env.APP_ROLE_SECRET ?? "";
  const ownerSecret = process.env.OWNER_ROLE_SECRET ?? "";
  const appAuth = appSecret ? `:${appSecret}` : "";
  const ownerAuth = ownerSecret ? `:${ownerSecret}` : "";

  const appDbUrl =
    process.env.APP_DATABASE_URL ??
    `postgresql://progresseye_app${appAuth}@${host}:${port}/${dbName}`;
  const ownerDbUrl =
    process.env.OWNER_DATABASE_URL ??
    `postgresql://progresseye_owner${ownerAuth}@${host}:${port}/${dbName}`;

  beforeAll(async () => {
    tenantContext = new TenantContextService();
    prisma = new PrismaService(tenantContext);
    await prisma.$connect();

    // Clean up any existing test entities
    await prisma.$executeRawUnsafe(
      `TRUNCATE TABLE organizations, schools, academic_years, users, sessions, roles, permissions, role_permissions, user_roles, audit_logs, outbox_events, counters, password_reset_tokens, email_verification_tokens CASCADE;`,
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
      const appPrisma = new PrismaClient({
        datasources: { db: { url: appDbUrl } },
      });
      await appPrisma.$connect();

      const users: any[] = await appPrisma.$queryRaw`SELECT id FROM users;`;
      expect(users.length).toBe(0);

      const academicYears: any[] = await appPrisma.$queryRaw`SELECT id FROM academic_years;`;
      expect(academicYears.length).toBe(0);

      const sessions: any[] = await appPrisma.$queryRaw`SELECT id FROM sessions;`;
      expect(sessions.length).toBe(0);

      const auditLogs: any[] = await appPrisma.$queryRaw`SELECT id FROM audit_logs;`;
      expect(auditLogs.length).toBe(0);

      const resetTokens: any[] = await appPrisma.$queryRaw`SELECT id FROM password_reset_tokens;`;
      expect(resetTokens.length).toBe(0);

      const verifyTokens: any[] =
        await appPrisma.$queryRaw`SELECT id FROM email_verification_tokens;`;
      expect(verifyTokens.length).toBe(0);

      await appPrisma.$disconnect();
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

      // Cross-tenant read under owner: with Tenant A context, querying for Tenant B's rows returns 0 rows
      await ownerPrisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.current_school_id', ${schoolA}, true);`;
        const crossTenantUsers: any[] = await tx.$queryRaw`
          SELECT id FROM users WHERE school_id = ${schoolB}::uuid;
        `;
        expect(crossTenantUsers.length).toBe(0);
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

  describe("Test 12: Caller Transactions, Extension Scoping & Concurrency Isolation", () => {
    let appPrismaService: PrismaService;

    beforeAll(async () => {
      appPrismaService = new PrismaService(tenantContext, {
        datasources: { db: { url: appDbUrl } },
      });
      await appPrismaService.$connect();
    });

    afterAll(async () => {
      await appPrismaService.$disconnect();
    });

    // (a) two writes in one caller transaction, then a throw, assert both rolled back
    it("(a) should rollback two writes in one caller transaction when an error is thrown", async () => {
      const email1 = `rollback-1-${uuidv7().substring(0, 8)}@test.com`;
      const email2 = `rollback-2-${uuidv7().substring(0, 8)}@test.com`;

      await expect(
        appPrismaService.withTenant(schoolA, async (tx) => {
          await tx.user.create({
            data: {
              id: uuidv7(),
              schoolId: schoolA,
              email: email1,
              firstName: "Rollback",
              lastName: "One",
            },
          });
          await tx.user.create({
            data: {
              id: uuidv7(),
              schoolId: schoolA,
              email: email2,
              firstName: "Rollback",
              lastName: "Two",
            },
          });
          throw new Error("Intentional caller transaction failure");
        }),
      ).rejects.toThrow("Intentional caller transaction failure");

      // Verify that neither user was committed
      await appPrismaService.withTenant(schoolA, async (tx) => {
        const users = await tx.user.findMany({
          where: { email: { in: [email1, email2] } },
        });
        expect(users.length).toBe(0);
      });
    });

    // (b) reads in a caller transaction see only the current tenant
    it("(b) should scope reads inside a caller transaction strictly to the current tenant", async () => {
      await appPrismaService.withTenant(schoolA, async (tx) => {
        const users = await tx.user.findMany();
        expect(users.length).toBeGreaterThanOrEqual(1);
        for (const u of users) {
          expect(u.schoolId).toBe(schoolA);
        }
        // Explicitly querying WHERE school_id = schoolB inside Tenant A caller transaction yields 0 rows
        const crossTenantUsers = await tx.user.findMany({
          where: { schoolId: schoolB },
        });
        expect(crossTenantUsers.length).toBe(0);
      });
    });

    // (c) $queryRaw and $executeRaw under the extension are tenant-scoped
    it("(c) should enforce tenant scoping on $queryRaw and $executeRaw under the client extension", async () => {
      await tenantContext.run({ schoolId: schoolA }, async () => {
        const rawUsers: any[] = await appPrismaService.client.$queryRaw`
          SELECT id, school_id FROM users WHERE id = ${userAId}::uuid;
        `;
        expect(rawUsers.length).toBe(1);
        expect(rawUsers[0].id).toBe(userAId);
        expect(rawUsers[0].school_id).toBe(schoolA);

        // Update under Tenant A context works for Tenant A row
        const updateCount = await appPrismaService.client.$executeRaw`
          UPDATE users SET first_name = 'AliceUpdated' WHERE id = ${userAId}::uuid;
        `;
        expect(updateCount).toBe(1);

        // Cross-tenant update under Tenant A context cannot touch Tenant B row
        const crossUpdateCount = await appPrismaService.client.$executeRaw`
          UPDATE users SET first_name = 'Hacked' WHERE id = ${userBId}::uuid;
        `;
        expect(crossUpdateCount).toBe(0);
      });
    });

    // (d) 20 parallel mixed read/write requests for tenants A and B with no leakage
    it("(d) should handle 20 parallel mixed read and write requests across tenants without leakage", async () => {
      const operations = Array.from({ length: 20 }).map((_, i) => {
        const isTenantA = i % 2 === 0;
        const currentSchoolId = isTenantA ? schoolA : schoolB;
        const expectedUserId = isTenantA ? userAId : userBId;
        const isWrite = i % 4 === 0;

        return tenantContext.run({ schoolId: currentSchoolId }, async () => {
          if (isWrite) {
            const tempEmail = `mixed-${i}-${uuidv7().substring(0, 8)}@example.com`;
            const created = await (appPrismaService.client as any).user.create({
              data: {
                id: uuidv7(),
                schoolId: currentSchoolId,
                email: tempEmail,
                firstName: "Mixed",
                lastName: `User${i}`,
              },
            });
            expect(created.schoolId).toBe(currentSchoolId);
            return { type: "write", schoolId: currentSchoolId };
          } else {
            const users = await (appPrismaService.client as any).user.findMany({
              where: { id: expectedUserId },
            });
            expect(users.length).toBe(1);
            expect(users[0].schoolId).toBe(currentSchoolId);
            return { type: "read", schoolId: currentSchoolId };
          }
        });
      });

      const results = await Promise.all(operations);
      expect(results.length).toBe(20);
      expect(results.filter((r) => r.schoolId === schoolA).length).toBe(10);
      expect(results.filter((r) => r.schoolId === schoolB).length).toBe(10);
    });

    // (e) pool exhaustion check: 50 sequential calls with a pool of 5 complete
    it("(e) should complete 50 sequential calls without pool exhaustion on a pool size of 5", async () => {
      const poolUrl = `${appDbUrl}${appDbUrl.includes("?") ? "&" : "?"}connection_limit=5`;
      const poolPrisma = new PrismaService(tenantContext, {
        datasources: { db: { url: poolUrl } },
      });
      await poolPrisma.$connect();

      for (let i = 0; i < 50; i++) {
        const user = await poolPrisma.withTenant(schoolA, async (tx) => {
          return tx.user.findFirst({ where: { id: userAId } });
        });
        expect(user).toBeDefined();
        expect(user?.id).toBe(userAId);
      }

      await poolPrisma.$disconnect();
    });

    it("should forbid nested $transaction on the tenant-scoped extended client", async () => {
      await expect((appPrismaService.client as any).$transaction(async () => {})).rejects.toThrow(
        "Nested $transaction is not permitted on tenant-scoped client",
      );
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

  describe("Test 19: Phase 12b-1 Password Reset & Email Verification Tokens RLS Isolation (Amendment 2)", () => {
    let appPrisma: PrismaService;
    const testResetTokenId = uuidv7();
    const testVerifyTokenId = uuidv7();

    beforeAll(async () => {
      appPrisma = new PrismaService(tenantContext, {
        datasources: { db: { url: appDbUrl } },
      });
      await appPrisma.$connect();
    });

    afterAll(async () => {
      await appPrisma.$disconnect();
    });

    it("should allow Tenant A to insert and read its own password reset and verification tokens", async () => {
      await tenantContext.run({ schoolId: schoolA }, async () => {
        const client = appPrisma.client;

        await client.$executeRaw`
          INSERT INTO password_reset_tokens (id, school_id, user_id, token_hash, expires_at)
          VALUES (${testResetTokenId}::uuid, ${schoolA}::uuid, ${userAId}::uuid, 'reset-hash-a', CURRENT_TIMESTAMP + INTERVAL '1 hour');
        `;

        await client.$executeRaw`
          INSERT INTO email_verification_tokens (id, school_id, user_id, token_hash, expires_at)
          VALUES (${testVerifyTokenId}::uuid, ${schoolA}::uuid, ${userAId}::uuid, 'verify-hash-a', CURRENT_TIMESTAMP + INTERVAL '24 hours');
        `;

        const resetTokens: any[] = await client.$queryRaw`
          SELECT id, token_hash FROM password_reset_tokens WHERE id = ${testResetTokenId}::uuid;
        `;
        expect(resetTokens.length).toBe(1);
        expect(resetTokens[0].token_hash).toBe("reset-hash-a");

        const verifyTokens: any[] = await client.$queryRaw`
          SELECT id, token_hash FROM email_verification_tokens WHERE id = ${testVerifyTokenId}::uuid;
        `;
        expect(verifyTokens.length).toBe(1);
        expect(verifyTokens[0].token_hash).toBe("verify-hash-a");
      });
    });

    it("should prevent Tenant B from reading Tenant A reset or verification tokens (cross-tenant read isolation)", async () => {
      await tenantContext.run({ schoolId: schoolB }, async () => {
        const client = appPrisma.client;

        const resetTokens: any[] = await client.$queryRaw`
          SELECT id FROM password_reset_tokens WHERE id = ${testResetTokenId}::uuid;
        `;
        expect(resetTokens.length).toBe(0);

        const verifyTokens: any[] = await client.$queryRaw`
          SELECT id FROM email_verification_tokens WHERE id = ${testVerifyTokenId}::uuid;
        `;
        expect(verifyTokens.length).toBe(0);
      });
    });

    it("should reject cross-tenant inserts for reset and verification tokens (RLS WITH CHECK)", async () => {
      const maliciousId = uuidv7();
      await tenantContext.run({ schoolId: schoolA }, async () => {
        const client = appPrisma.client;

        await expect(
          client.$executeRaw`
            INSERT INTO password_reset_tokens (id, school_id, user_id, token_hash, expires_at)
            VALUES (${maliciousId}::uuid, ${schoolB}::uuid, ${userBId}::uuid, 'malicious-reset-hash', CURRENT_TIMESTAMP + INTERVAL '1 hour');
          `,
        ).rejects.toThrow();

        await expect(
          client.$executeRaw`
            INSERT INTO email_verification_tokens (id, school_id, user_id, token_hash, expires_at)
            VALUES (${maliciousId}::uuid, ${schoolB}::uuid, ${userBId}::uuid, 'malicious-verify-hash', CURRENT_TIMESTAMP + INTERVAL '24 hours');
          `,
        ).rejects.toThrow();
      });
    });

    it("should prevent Tenant B from updating Tenant A tokens (0 rows affected)", async () => {
      await tenantContext.run({ schoolId: schoolB }, async () => {
        const client = appPrisma.client;

        const updateResetCount = await client.$executeRaw`
          UPDATE password_reset_tokens
          SET used_at = CURRENT_TIMESTAMP
          WHERE id = ${testResetTokenId}::uuid;
        `;
        expect(updateResetCount).toBe(0);

        const updateVerifyCount = await client.$executeRaw`
          UPDATE email_verification_tokens
          SET used_at = CURRENT_TIMESTAMP
          WHERE id = ${testVerifyTokenId}::uuid;
        `;
        expect(updateVerifyCount).toBe(0);
      });
    });

    it("should reject DELETE on token tables under progresseye_app (permission denied)", async () => {
      await tenantContext.run({ schoolId: schoolA }, async () => {
        const client = appPrisma.client;

        await expect(
          client.$executeRaw`
            DELETE FROM password_reset_tokens WHERE id = ${testResetTokenId}::uuid;
          `,
        ).rejects.toThrow(/permission denied for table password_reset_tokens/);

        await expect(
          client.$executeRaw`
            DELETE FROM email_verification_tokens WHERE id = ${testVerifyTokenId}::uuid;
          `,
        ).rejects.toThrow(/permission denied for table email_verification_tokens/);
      });
    });

    it("should prevent cross-tenant token deletion under progresseye_owner (0 rows affected via RLS)", async () => {
      const ownerPrisma = new PrismaClient({
        datasources: { db: { url: ownerDbUrl } },
      });
      await ownerPrisma.$connect();

      // Connected as owner with Tenant B context: attempting to delete Tenant A's token deletes 0 rows due to FORCE RLS
      await ownerPrisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.current_school_id', ${schoolB}, true);`;
        const deletedCount = await tx.$executeRaw`
          DELETE FROM email_verification_tokens WHERE id = ${testVerifyTokenId}::uuid;
        `;
        expect(deletedCount).toBe(0);
      });

      await ownerPrisma.$disconnect();
    });

    it("should reject Nil-UUID as school_id for new token tables via check constraints", async () => {
      const nilUuid = "00000000-0000-0000-0000-000000000000";
      const tokenUuid = uuidv7();

      await expect(
        prisma.$executeRaw`
          INSERT INTO password_reset_tokens (id, school_id, user_id, token_hash, expires_at)
          VALUES (${tokenUuid}::uuid, ${nilUuid}::uuid, ${userAId}::uuid, 'nil-reset-hash', CURRENT_TIMESTAMP + INTERVAL '1 hour');
        `,
      ).rejects.toThrow();

      await expect(
        prisma.$executeRaw`
          INSERT INTO email_verification_tokens (id, school_id, user_id, token_hash, expires_at)
          VALUES (${tokenUuid}::uuid, ${nilUuid}::uuid, ${userAId}::uuid, 'nil-verify-hash', CURRENT_TIMESTAMP + INTERVAL '24 hours');
        `,
      ).rejects.toThrow();
    });

    it("should enforce FORCE RLS even on progresseye_owner (fail-closed without tenant context, scoped with tenant context)", async () => {
      const ownerPrisma = new PrismaClient({
        datasources: { db: { url: ownerDbUrl } },
      });
      await ownerPrisma.$connect();

      // Query with empty context: returns 0 rows (FORCE RLS enforces fail-closed against owner)
      const emptyReset: any[] = await ownerPrisma.$queryRaw`
        SELECT id FROM password_reset_tokens WHERE id = ${testResetTokenId}::uuid;
      `;
      expect(emptyReset.length).toBe(0);

      const emptyVerify: any[] = await ownerPrisma.$queryRaw`
        SELECT id FROM email_verification_tokens WHERE id = ${testVerifyTokenId}::uuid;
      `;
      expect(emptyVerify.length).toBe(0);

      // Query with Tenant A context: sees Tenant A tokens
      await ownerPrisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.current_school_id', ${schoolA}, true);`;
        const resetTokens: any[] = await tx.$queryRaw`
          SELECT id FROM password_reset_tokens WHERE id = ${testResetTokenId}::uuid;
        `;
        expect(resetTokens.length).toBe(1);

        const verifyTokens: any[] = await tx.$queryRaw`
          SELECT id FROM email_verification_tokens WHERE id = ${testVerifyTokenId}::uuid;
        `;
        expect(verifyTokens.length).toBe(1);
      });

      // Query with Tenant B context: sees 0 rows for Tenant A tokens
      await ownerPrisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.current_school_id', ${schoolB}, true);`;
        const resetTokens: any[] = await tx.$queryRaw`
          SELECT id FROM password_reset_tokens WHERE id = ${testResetTokenId}::uuid;
        `;
        expect(resetTokens.length).toBe(0);
      });

      await ownerPrisma.$disconnect();
    });

    it("should enforce minimal role grants: progresseye_ro cannot insert into token tables", async () => {
      await tenantContext.run({ schoolId: schoolA }, async () => {
        const client = prisma.client;
        await client.$executeRawUnsafe(`SET ROLE progresseye_ro;`);

        const tokenUuid = uuidv7();
        await expect(
          client.$executeRaw`
            INSERT INTO password_reset_tokens (id, school_id, user_id, token_hash, expires_at)
            VALUES (${tokenUuid}::uuid, ${schoolA}::uuid, ${userAId}::uuid, 'ro-forbidden-hash', CURRENT_TIMESTAMP + INTERVAL '1 hour');
          `,
        ).rejects.toThrow(/permission denied/i);

        await client.$executeRawUnsafe(`RESET ROLE;`);
      });
    });
  });

  describe("Test 20: Phase 12b-2 Two-Factor Secrets and Recovery Codes RLS Isolation", () => {
    let appPrisma: PrismaService;
    const testSecretId = uuidv7();
    const testRecoveryCodeId = uuidv7();

    beforeAll(async () => {
      appPrisma = new PrismaService(tenantContext, {
        datasources: { db: { url: appDbUrl } },
      });
      await appPrisma.$connect();
    });

    afterAll(async () => {
      await appPrisma.$disconnect();
    });

    it("should allow Tenant A to insert and read its own 2FA secret and recovery codes", async () => {
      await tenantContext.run({ schoolId: schoolA }, async () => {
        const client = appPrisma.client;

        await client.$executeRaw`
          INSERT INTO user_two_factor_secrets (id, school_id, user_id, encrypted_secret, iv, auth_tag, is_verified)
          VALUES (${testSecretId}::uuid, ${schoolA}::uuid, ${userAId}::uuid, 'enc-secret-a', 'iv-a', 'tag-a', false);
        `;

        await client.$executeRaw`
          INSERT INTO user_recovery_codes (id, school_id, user_id, code_hash)
          VALUES (${testRecoveryCodeId}::uuid, ${schoolA}::uuid, ${userAId}::uuid, 'recovery-hash-a');
        `;

        const secrets: any[] = await client.$queryRaw`
          SELECT id, encrypted_secret FROM user_two_factor_secrets WHERE id = ${testSecretId}::uuid;
        `;
        expect(secrets.length).toBe(1);
        expect(secrets[0].encrypted_secret).toBe("enc-secret-a");

        const codes: any[] = await client.$queryRaw`
          SELECT id, code_hash FROM user_recovery_codes WHERE id = ${testRecoveryCodeId}::uuid;
        `;
        expect(codes.length).toBe(1);
        expect(codes[0].code_hash).toBe("recovery-hash-a");
      });
    });

    it("should prevent Tenant B from reading Tenant A 2FA secrets or recovery codes (cross-tenant read isolation)", async () => {
      await tenantContext.run({ schoolId: schoolB }, async () => {
        const client = appPrisma.client;

        const secrets: any[] = await client.$queryRaw`
          SELECT id FROM user_two_factor_secrets WHERE id = ${testSecretId}::uuid;
        `;
        expect(secrets.length).toBe(0);

        const codes: any[] = await client.$queryRaw`
          SELECT id FROM user_recovery_codes WHERE id = ${testRecoveryCodeId}::uuid;
        `;
        expect(codes.length).toBe(0);
      });
    });

    it("should reject cross-tenant inserts for 2FA secrets and recovery codes (RLS WITH CHECK)", async () => {
      const maliciousId = uuidv7();
      await tenantContext.run({ schoolId: schoolA }, async () => {
        const client = appPrisma.client;

        await expect(
          client.$executeRaw`
            INSERT INTO user_two_factor_secrets (id, school_id, user_id, encrypted_secret, iv, auth_tag, is_verified)
            VALUES (${maliciousId}::uuid, ${schoolB}::uuid, ${userBId}::uuid, 'malicious-enc-secret', 'iv-b', 'tag-b', false);
          `,
        ).rejects.toThrow();

        await expect(
          client.$executeRaw`
            INSERT INTO user_recovery_codes (id, school_id, user_id, code_hash)
            VALUES (${maliciousId}::uuid, ${schoolB}::uuid, ${userBId}::uuid, 'malicious-recovery-hash');
          `,
        ).rejects.toThrow();
      });
    });

    it("should prevent Tenant B from updating Tenant A 2FA secrets or recovery codes (0 rows affected)", async () => {
      await tenantContext.run({ schoolId: schoolB }, async () => {
        const client = appPrisma.client;

        const updateSecretCount = await client.$executeRaw`
          UPDATE user_two_factor_secrets
          SET is_verified = true
          WHERE id = ${testSecretId}::uuid;
        `;
        expect(updateSecretCount).toBe(0);

        const updateCodeCount = await client.$executeRaw`
          UPDATE user_recovery_codes
          SET used_at = CURRENT_TIMESTAMP
          WHERE id = ${testRecoveryCodeId}::uuid;
        `;
        expect(updateCodeCount).toBe(0);
      });
    });

    it("should reject DELETE on 2FA tables under progresseye_app (permission denied)", async () => {
      await tenantContext.run({ schoolId: schoolA }, async () => {
        const client = appPrisma.client;

        await expect(
          client.$executeRaw`
            DELETE FROM user_two_factor_secrets WHERE id = ${testSecretId}::uuid;
          `,
        ).rejects.toThrow(/permission denied for table user_two_factor_secrets/);

        await expect(
          client.$executeRaw`
            DELETE FROM user_recovery_codes WHERE id = ${testRecoveryCodeId}::uuid;
          `,
        ).rejects.toThrow(/permission denied for table user_recovery_codes/);
      });
    });

    it("should prevent cross-tenant 2FA table deletion under progresseye_owner (0 rows affected via RLS)", async () => {
      const ownerPrisma = new PrismaClient({
        datasources: { db: { url: ownerDbUrl } },
      });
      await ownerPrisma.$connect();

      await ownerPrisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.current_school_id', ${schoolB}, true);`;
        const deletedSecretCount = await tx.$executeRaw`
          DELETE FROM user_two_factor_secrets WHERE id = ${testSecretId}::uuid;
        `;
        expect(deletedSecretCount).toBe(0);

        const deletedCodeCount = await tx.$executeRaw`
          DELETE FROM user_recovery_codes WHERE id = ${testRecoveryCodeId}::uuid;
        `;
        expect(deletedCodeCount).toBe(0);
      });

      await ownerPrisma.$disconnect();
    });

    it("should reject Nil-UUID as school_id for 2FA tables via check constraints", async () => {
      const nilUuid = "00000000-0000-0000-0000-000000000000";
      const recordUuid = uuidv7();

      await expect(
        prisma.$executeRaw`
          INSERT INTO user_two_factor_secrets (id, school_id, user_id, encrypted_secret, iv, auth_tag, is_verified)
          VALUES (${recordUuid}::uuid, ${nilUuid}::uuid, ${userAId}::uuid, 'nil-secret', 'iv', 'tag', false);
        `,
      ).rejects.toThrow();

      await expect(
        prisma.$executeRaw`
          INSERT INTO user_recovery_codes (id, school_id, user_id, code_hash)
          VALUES (${recordUuid}::uuid, ${nilUuid}::uuid, ${userAId}::uuid, 'nil-code-hash');
        `,
      ).rejects.toThrow();
    });

    it("should enforce FORCE RLS even on progresseye_owner for 2FA tables (fail-closed without tenant context, scoped with tenant context)", async () => {
      const ownerPrisma = new PrismaClient({
        datasources: { db: { url: ownerDbUrl } },
      });
      await ownerPrisma.$connect();

      // Query with empty context: returns 0 rows (FORCE RLS enforces fail-closed against owner)
      const emptySecrets: any[] = await ownerPrisma.$queryRaw`
        SELECT id FROM user_two_factor_secrets WHERE id = ${testSecretId}::uuid;
      `;
      expect(emptySecrets.length).toBe(0);

      const emptyCodes: any[] = await ownerPrisma.$queryRaw`
        SELECT id FROM user_recovery_codes WHERE id = ${testRecoveryCodeId}::uuid;
      `;
      expect(emptyCodes.length).toBe(0);

      // Query with Tenant A context: sees Tenant A records
      await ownerPrisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.current_school_id', ${schoolA}, true);`;
        const secrets: any[] = await tx.$queryRaw`
          SELECT id FROM user_two_factor_secrets WHERE id = ${testSecretId}::uuid;
        `;
        expect(secrets.length).toBe(1);

        const codes: any[] = await tx.$queryRaw`
          SELECT id FROM user_recovery_codes WHERE id = ${testRecoveryCodeId}::uuid;
        `;
        expect(codes.length).toBe(1);
      });

      // Query with Tenant B context: sees 0 rows for Tenant A records
      await ownerPrisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.current_school_id', ${schoolB}, true);`;
        const secrets: any[] = await tx.$queryRaw`
          SELECT id FROM user_two_factor_secrets WHERE id = ${testSecretId}::uuid;
        `;
        expect(secrets.length).toBe(0);
      });

      await ownerPrisma.$disconnect();
    });

    it("should enforce minimal role grants: progresseye_ro cannot insert into 2FA tables", async () => {
      await tenantContext.run({ schoolId: schoolA }, async () => {
        const client = prisma.client;
        await client.$executeRawUnsafe(`SET ROLE progresseye_ro;`);

        const recordUuid = uuidv7();
        await expect(
          client.$executeRaw`
            INSERT INTO user_two_factor_secrets (id, school_id, user_id, encrypted_secret, iv, auth_tag, is_verified)
            VALUES (${recordUuid}::uuid, ${schoolA}::uuid, ${userAId}::uuid, 'ro-forbidden', 'iv', 'tag', false);
          `,
        ).rejects.toThrow(/permission denied/i);

        await expect(
          client.$executeRaw`
            INSERT INTO user_recovery_codes (id, school_id, user_id, code_hash)
            VALUES (${recordUuid}::uuid, ${schoolA}::uuid, ${userAId}::uuid, 'ro-forbidden-hash');
          `,
        ).rejects.toThrow(/permission denied/i);

        await client.$executeRawUnsafe(`RESET ROLE;`);
      });
    });
  });

  describe("Test 14: Migration Deploy from Empty Database", () => {
    const dbUrlBase =
      process.env.DATABASE_URL?.substring(0, process.env.DATABASE_URL.lastIndexOf("/")) ??
      "postgresql://postgres@localhost:5432";

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
      "postgresql://postgres@localhost:5432";

    it("should deploy cleanly from current main schema upgrade with sample tenant data", async () => {
      await prisma.$executeRawUnsafe(`DROP DATABASE IF EXISTS test_db_from_main;`);
      await prisma.$executeRawUnsafe(`CREATE DATABASE test_db_from_main;`);

      const mainPrisma = new PrismaClient({
        datasources: { db: { url: `${dbUrlBase}/test_db_from_main` } },
      });
      await mainPrisma.$connect();

      // Create _prisma_migrations table
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

      const baselineMigrations = [
        "20261012000000_enable_postgresql_extensions",
        "20261024000000_create_public_leads",
        "20261024010000_add_notified_at_to_leads",
        "20261102000000_tenancy_and_row_level_security",
        "20261108000000_auth_and_session_foundation",
        "20261109000000_account_lifecycle_and_reset_tokens",
      ];

      const migrationsDir = path.resolve(__dirname, "../../prisma/migrations");
      const upgradeDbUrl = `${dbUrlBase}/test_db_from_main`;

      for (const mig of baselineMigrations) {
        const migFile = path.join(migrationsDir, mig, "migration.sql");
        execSync(`pnpm prisma db execute --file "${migFile}" --url "${upgradeDbUrl}"`, {
          encoding: "utf8",
        });

        const checksum = crypto.createHash("sha256").update(fs.readFileSync(migFile)).digest("hex");
        const migId = crypto.randomUUID();
        await mainPrisma.$executeRawUnsafe(`
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

      await mainPrisma.$executeRawUnsafe(`
        INSERT INTO schools (id, slug, name, updated_at)
        VALUES ('${sampleSchoolId}'::uuid, 'main-school', 'Main School', CURRENT_TIMESTAMP);
      `);

      await mainPrisma.$executeRawUnsafe(`
        INSERT INTO users (id, school_id, email, first_name, last_name, password_hash, email_verified_at, updated_at)
        VALUES ('${sampleUserId}'::uuid, '${sampleSchoolId}'::uuid, 'main-user@example.com', 'Main', 'User', 'seeded_hash', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
      `);

      await mainPrisma.$executeRawUnsafe(`
        INSERT INTO sessions (id, school_id, user_id, refresh_token_hash, family_id, expires_at, created_at, updated_at)
        VALUES ('${sampleSessionId}'::uuid, '${sampleSchoolId}'::uuid, '${sampleUserId}'::uuid, 'seeded_refresh_hash', '${sampleFamilyId}'::uuid, CURRENT_TIMESTAMP + INTERVAL '7 days', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
      `);

      await mainPrisma.$executeRawUnsafe(`
        INSERT INTO password_reset_tokens (id, school_id, user_id, token_hash, expires_at, created_at)
        VALUES ('${sampleResetTokenId}'::uuid, '${sampleSchoolId}'::uuid, '${sampleUserId}'::uuid, 'seeded_reset_hash', CURRENT_TIMESTAMP + INTERVAL '1 hour', CURRENT_TIMESTAMP);
      `);

      await mainPrisma.$executeRawUnsafe(`
        INSERT INTO email_verification_tokens (id, school_id, user_id, token_hash, expires_at, created_at)
        VALUES ('${sampleVerifyTokenId}'::uuid, '${sampleSchoolId}'::uuid, '${sampleUserId}'::uuid, 'seeded_verify_hash', CURRENT_TIMESTAMP + INTERVAL '24 hours', CURRENT_TIMESTAMP);
      `);

      // Run prisma migrate deploy to apply Phase 12b-2 upgrade migration
      execSync("pnpm prisma migrate deploy", {
        env: {
          ...process.env,
          DATABASE_URL: upgradeDbUrl,
          DIRECT_URL: upgradeDbUrl,
        },
        stdio: "pipe",
      });

      // Verify existing data preserved and new schema active
      const school: any[] = await mainPrisma.$queryRaw`
        SELECT id, slug, name FROM schools WHERE slug = 'main-school';
      `;
      expect(school.length).toBe(1);
      expect(school[0].name).toBe("Main School");

      const user: any[] = await mainPrisma.$queryRaw`
        SELECT id, email, is_two_factor_enabled FROM users WHERE id = ${sampleUserId}::uuid;
      `;
      expect(user.length).toBe(1);
      expect(user[0].is_two_factor_enabled).toBe(false);

      const session: any[] = await mainPrisma.$queryRaw`
        SELECT id, refresh_token_hash FROM sessions WHERE id = ${sampleSessionId}::uuid;
      `;
      expect(session.length).toBe(1);

      const resetToken: any[] = await mainPrisma.$queryRaw`
        SELECT id, token_hash FROM password_reset_tokens WHERE id = ${sampleResetTokenId}::uuid;
      `;
      expect(resetToken.length).toBe(1);

      const verifyToken: any[] = await mainPrisma.$queryRaw`
        SELECT id, token_hash FROM email_verification_tokens WHERE id = ${sampleVerifyTokenId}::uuid;
      `;
      expect(verifyToken.length).toBe(1);

      const totpTable: any[] = await mainPrisma.$queryRaw`
        SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename = 'user_two_factor_secrets';
      `;
      expect(totpTable.length).toBe(1);

      const recoveryTable: any[] = await mainPrisma.$queryRaw`
        SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename = 'user_recovery_codes';
      `;
      expect(recoveryTable.length).toBe(1);

      await mainPrisma.$disconnect();
    });
  });
});
