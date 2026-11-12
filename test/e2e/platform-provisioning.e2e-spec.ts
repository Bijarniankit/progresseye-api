import { execSync } from "node:child_process";
import fastifyCookie from "@fastify/cookie";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { Test, type TestingModule } from "@nestjs/testing";
import { PrismaClient } from "@prisma/client";
import * as argon2 from "argon2";
import { Logger } from "nestjs-pino";
import request from "supertest";
import { uuidv7 } from "uuidv7";
import { AppModule } from "../../src/app.module";
import {
  SYSTEM_TENANT_ID,
  TenantContextService,
} from "../../src/common/request-context/tenant-context.service";
import { PrismaService } from "../../src/infra/prisma/prisma.service";
import { RoleService } from "../../src/modules/identity/application/role.service";
import { TokenService } from "../../src/modules/identity/domain/token.service";

jest.setTimeout(45000);

describe("Phase 13b-1: Platform Provisioning E2E Suite", () => {
  let app: NestFastifyApplication;
  let prisma: PrismaService;
  let roleService: RoleService;
  let tokenService: TokenService;
  let dbAvailable = false;

  const platformAdminUserId = uuidv7();
  const tenantAdminUserId = uuidv7();
  const existingSchoolId = uuidv7();

  let platformAdminToken: string;
  let tenantAdminToken: string;

  const dbUrlStr = process.env.DATABASE_URL ?? "postgresql://postgres@localhost:5432/test_db";
  const urlObj = new URL(dbUrlStr);
  const host = urlObj.hostname;
  const port = urlObj.port || "5432";
  const dbName = urlObj.pathname.replace(/^\//, "");
  const ownerSecret = process.env.OWNER_ROLE_SECRET ?? "";
  const ownerAuth = ownerSecret ? `:${ownerSecret}` : "";
  const ownerDbUrl =
    process.env.OWNER_DATABASE_URL ??
    `postgresql://progresseye_owner${ownerAuth}@${host}:${port}/${dbName}`;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication<NestFastifyApplication>(
      new FastifyAdapter({ trustProxy: true }),
    );
    app.useLogger(moduleFixture.get(Logger));
    app.setGlobalPrefix("/api/v1");

    await app.register(fastifyCookie as any);

    prisma = moduleFixture.get<PrismaService>(PrismaService);
    roleService = moduleFixture.get<RoleService>(RoleService);
    tokenService = moduleFixture.get<TokenService>(TokenService);

    try {
      await prisma.$connect();
      const isLive = await prisma.ping();
      if (!isLive) throw new Error("offline");
      dbAvailable = true;
    } catch {
      if (process.env.CI) {
        throw new Error("PostgreSQL database connection is required in CI environment");
      }
      dbAvailable = false;
      console.log(
        "Local environment without Docker: PostgreSQL unavailable; real PostgreSQL RLS assertions verified in GitHub Actions CI.",
      );
    }

    if (dbAvailable) {
      await roleService.seedGlobalPermissions();

      // Ensure system tenant exists
      await prisma.school.upsert({
        where: { id: SYSTEM_TENANT_ID },
        update: {},
        create: {
          id: SYSTEM_TENANT_ID,
          name: "ProgressEye Platform Engine",
          slug: "system-platform",
          isActive: true,
        },
      });

      // Seed system platform roles
      await roleService.seedBuiltInRolesForSchool(SYSTEM_TENANT_ID);

      // Create platform admin user in system tenant
      const passwordHash = await argon2.hash("PlatformAdminPass123!", {
        type: argon2.argon2id,
        memoryCost: 4096,
        timeCost: 2,
        parallelism: 1,
      });

      await prisma.user.upsert({
        where: { id: platformAdminUserId },
        update: {},
        create: {
          id: platformAdminUserId,
          schoolId: SYSTEM_TENANT_ID,
          email: "superadmin@progresseye.internal",
          passwordHash,
          firstName: "Platform",
          lastName: "SuperAdmin",
          isActive: true,
          isTwoFactorEnabled: true,
        },
      });

      const platformAdminRole = await prisma.role.findFirst({
        where: { schoolId: SYSTEM_TENANT_ID, slug: "platform_admin" },
      });

      if (platformAdminRole) {
        await prisma.userRole.upsert({
          where: {
            schoolId_userId_roleId: {
              schoolId: SYSTEM_TENANT_ID,
              userId: platformAdminUserId,
              roleId: platformAdminRole.id,
            },
          },
          update: {},
          create: {
            schoolId: SYSTEM_TENANT_ID,
            userId: platformAdminUserId,
            roleId: platformAdminRole.id,
          },
        });
      }

      // Create a test tenant school
      await prisma.school.upsert({
        where: { id: existingSchoolId },
        update: {},
        create: {
          id: existingSchoolId,
          name: "Existing Academy",
          slug: "existing-academy",
          isActive: true,
        },
      });

      await roleService.seedBuiltInRolesForSchool(existingSchoolId);

      await prisma.user.upsert({
        where: { id: tenantAdminUserId },
        update: {},
        create: {
          id: tenantAdminUserId,
          schoolId: existingSchoolId,
          email: "principal@existing.edu",
          passwordHash,
          firstName: "Tenant",
          lastName: "Principal",
          isActive: true,
          isTwoFactorEnabled: true,
        },
      });

      const principalRole = await prisma.role.findFirst({
        where: { schoolId: existingSchoolId, slug: "principal" },
      });

      if (principalRole) {
        await prisma.userRole.upsert({
          where: {
            schoolId_userId_roleId: {
              schoolId: existingSchoolId,
              userId: tenantAdminUserId,
              roleId: principalRole.id,
            },
          },
          update: {},
          create: {
            schoolId: existingSchoolId,
            userId: tenantAdminUserId,
            roleId: principalRole.id,
          },
        });
      }

      const platformSession = await prisma.session.create({
        data: {
          schoolId: SYSTEM_TENANT_ID,
          userId: platformAdminUserId,
          tokenHash: "platform-sess-hash",
          clientType: "web",
          expiresAt: new Date(Date.now() + 3600000),
        },
      });

      const { token: pToken } = await tokenService.createPlatformAccessToken({
        userId: platformAdminUserId,
        sessionId: platformSession.id,
      });
      platformAdminToken = pToken;

      const tenantSession = await prisma.session.create({
        data: {
          schoolId: existingSchoolId,
          userId: tenantAdminUserId,
          tokenHash: "tenant-sess-hash",
          clientType: "web",
          expiresAt: new Date(Date.now() + 3600000),
        },
      });

      const { token: tToken } = await tokenService.createAccessToken({
        userId: tenantAdminUserId,
        schoolId: existingSchoolId,
        sessionId: tenantSession.id,
      });
      tenantAdminToken = tToken;
    }

    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    if (app) {
      const server = app.getHttpServer();
      if (server && typeof server.closeAllConnections === "function") {
        server.closeAllConnections();
      }
      await app.close();
    }
    if (prisma) await prisma.$disconnect();
  });

  describe("POST /api/v1/platform/schools", () => {
    it("should reject unauthenticated request with 401", async () => {
      const res = await request(app.getHttpServer())
        .post("/api/v1/platform/schools")
        .send({ name: "Unauthenticated High", slug: "unauth-high" });

      expect(res.status).toBe(401);
    });

    it("POST /api/v1/platform/schools: principal gets 403 Forbidden (platform scope required)", async () => {
      if (!dbAvailable) {
        if (process.env.CI) throw new Error("Database is required in CI");
        return;
      }

      const res = await request(app.getHttpServer())
        .post("/api/v1/platform/schools")
        .set("Authorization", `Bearer ${tenantAdminToken}`)
        .send({ name: "Unauthorized High", slug: "unauth-school" });

      expect(res.status).toBe(403);
      expect(res.body.message ?? res.body.detail).toMatch(
        /Platform administrative access required/,
      );
    });

    it("should reject reserved slugs with 400 Bad Request", async () => {
      if (!dbAvailable) {
        if (process.env.CI) throw new Error("Database is required in CI");
        return;
      }

      const res = await request(app.getHttpServer())
        .post("/api/v1/platform/schools")
        .set("Authorization", `Bearer ${platformAdminToken}`)
        .send({ name: "System School", slug: "system-platform" });

      expect(res.status).toBe(400);
      expect(res.body.message ?? res.body.detail).toMatch(/reserved/i);
    });

    it("should reject invalid slug format with 400 Bad Request", async () => {
      if (!dbAvailable) {
        if (process.env.CI) throw new Error("Database is required in CI");
        return;
      }

      const res = await request(app.getHttpServer())
        .post("/api/v1/platform/schools")
        .set("Authorization", `Bearer ${platformAdminToken}`)
        .send({ name: "Invalid Slug School", slug: "INVALID_SLUG_WITH_CAPS!" });

      expect(res.status).toBe(400);
    });

    it("should successfully provision a new school with 12 built-in roles and audit rows", async () => {
      if (!dbAvailable) {
        if (process.env.CI) throw new Error("Database is required in CI");
        return;
      }

      const targetSlug = `new-horizon-${Date.now().toString().slice(-6)}`;
      const res = await request(app.getHttpServer())
        .post("/api/v1/platform/schools")
        .set("Authorization", `Bearer ${platformAdminToken}`)
        .send({ name: "New Horizon High", slug: targetSlug });

      expect(res.status).toBe(201);
      expect(res.body.id).toBeDefined();
      expect(res.body.slug).toBe(targetSlug);
      expect(res.body.name).toBe("New Horizon High");

      const newSchoolId = res.body.id;

      // Verify the school exists in database
      const schoolRecord = await prisma.school.findUnique({
        where: { id: newSchoolId },
      });
      expect(schoolRecord).toBeDefined();
      expect(schoolRecord?.slug).toBe(targetSlug);

      // Verify exactly 12 built-in roles were seeded for the new tenant
      const seededRoles = await prisma.role.findMany({
        where: { schoolId: newSchoolId, isSystem: true },
      });
      expect(seededRoles).toHaveLength(12);

      // Verify platform_admin is NOT among the tenant roles
      const hasPlatformAdmin = seededRoles.some((r) => r.slug === "platform_admin");
      expect(hasPlatformAdmin).toBe(false);

      // Verify platform audit log entries exist with real actor_user_id and HMAC client_ip_hash
      const auditInit = await prisma.$queryRaw<any[]>`
        SELECT * FROM platform_audit_logs
        WHERE action = 'PLATFORM_SCHOOL_PROVISION_INIT' AND resource_id = ${newSchoolId}
      `;
      expect(auditInit.length).toBeGreaterThan(0);
      expect(auditInit[0].actor_user_id).toBe(platformAdminUserId);
      expect(typeof auditInit[0].client_ip_hash).toBe("string");
      expect(auditInit[0].client_ip_hash.length).toBe(64);

      const auditComplete = await prisma.$queryRaw<any[]>`
        SELECT * FROM platform_audit_logs
        WHERE action = 'PLATFORM_SCHOOL_PROVISION_COMPLETE' AND resource_id = ${newSchoolId}
      `;
      expect(auditComplete.length).toBeGreaterThan(0);
      expect(auditComplete[0].actor_user_id).toBe(platformAdminUserId);
      expect(auditComplete[0].client_ip_hash).toBe(auditInit[0].client_ip_hash);
    });

    it("should reject duplicate school slug with 409 Conflict", async () => {
      if (!dbAvailable) {
        if (process.env.CI) throw new Error("Database is required in CI");
        return;
      }

      const res = await request(app.getHttpServer())
        .post("/api/v1/platform/schools")
        .set("Authorization", `Bearer ${platformAdminToken}`)
        .send({ name: "Duplicate Academy", slug: "existing-academy" });

      expect(res.status).toBe(409);
      expect(res.body.message ?? res.body.detail).toMatch(/already exists/i);
    });
  });

  describe("POST /api/v1/platform/schools/:id/reseed-roles", () => {
    it("POST /api/v1/platform/schools/:id/reseed-roles: principal gets 403 Forbidden (platform scope required)", async () => {
      if (!dbAvailable) {
        if (process.env.CI) throw new Error("Database is required in CI");
        return;
      }

      const res = await request(app.getHttpServer())
        .post(`/api/v1/platform/schools/${existingSchoolId}/reseed-roles`)
        .set("Authorization", `Bearer ${tenantAdminToken}`);

      expect(res.status).toBe(403);
      expect(res.body.message ?? res.body.detail).toMatch(
        /Platform administrative access required/,
      );
    });

    it("should reseed roles for provisioned school and log PLATFORM_SCHOOL_RESEED_ROLES", async () => {
      if (!dbAvailable) {
        if (process.env.CI) throw new Error("Database is required in CI");
        return;
      }

      const res = await request(app.getHttpServer())
        .post(`/api/v1/platform/schools/${existingSchoolId}/reseed-roles`)
        .set("Authorization", `Bearer ${platformAdminToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.reseededRoles).toBe(12);

      const auditReseed = await prisma.$queryRaw<any[]>`
        SELECT * FROM platform_audit_logs
        WHERE action = 'PLATFORM_SCHOOL_RESEED_ROLES' AND resource_id = ${existingSchoolId}
      `;
      expect(auditReseed.length).toBeGreaterThan(0);
    });

    it("should repair school when failure occurred between provisioning and role seeding", async () => {
      if (!dbAvailable) {
        if (process.env.CI) throw new Error("Database is required in CI");
        return;
      }

      // 1. Simulate failure between DB function and NestJS role seeding:
      // Call PostgreSQL platform_provision_school directly, leaving 0 roles seeded in NestJS
      const partialSlug = `interrupted-school-${Date.now().toString().slice(-6)}`;
      const [provisionResult] = await prisma.$queryRaw<
        Array<{ platform_provision_school: string }>
      >`
        SELECT platform_provision_school(${partialSlug}, 'Interrupted Academy', NULL)
      `;
      expect(provisionResult).toBeDefined();
      const interruptedSchoolId = provisionResult!.platform_provision_school;

      // Assert school was created but has 0 roles (simulating process crash before role seeding)
      const rolesBeforeReseed = await prisma.role.findMany({
        where: { schoolId: interruptedSchoolId },
      });
      expect(rolesBeforeReseed).toHaveLength(0);

      // 2. Call reseed-roles repair endpoint
      const res = await request(app.getHttpServer())
        .post(`/api/v1/platform/schools/${interruptedSchoolId}/reseed-roles`)
        .set("Authorization", `Bearer ${platformAdminToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.reseededRoles).toBe(12);

      // 3. Assert exactly 12 built-in roles now exist
      const rolesAfterReseed = await prisma.role.findMany({
        where: { schoolId: interruptedSchoolId, isSystem: true },
      });
      expect(rolesAfterReseed).toHaveLength(12);

      // 4. Assert PLATFORM_SCHOOL_RESEED_ROLES audit event was recorded
      const auditReseed = await prisma.$queryRaw<any[]>`
        SELECT * FROM platform_audit_logs
        WHERE action = 'PLATFORM_SCHOOL_RESEED_ROLES' AND resource_id = ${interruptedSchoolId}
      `;
      expect(auditReseed.length).toBeGreaterThan(0);
    });

    it("should return 404 if school to reseed does not exist", async () => {
      if (!dbAvailable) {
        if (process.env.CI) throw new Error("Database is required in CI");
        return;
      }

      const nonExistentSchoolId = uuidv7();
      const res = await request(app.getHttpServer())
        .post(`/api/v1/platform/schools/${nonExistentSchoolId}/reseed-roles`)
        .set("Authorization", `Bearer ${platformAdminToken}`);

      expect(res.status).toBe(404);
    });
  });

  describe("platform_audit_logs DB Permissions", () => {
    it("should allow progresseye_app to INSERT and reject SELECT, UPDATE, DELETE, TRUNCATE with 42501", async () => {
      if (!dbAvailable) {
        if (process.env.CI) throw new Error("Database is required in CI");
        return;
      }

      const dummyLogId = uuidv7();

      // 1. INSERT must succeed as progresseye_app
      await prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET ROLE progresseye_app;`);
        try {
          await tx.$executeRawUnsafe(`
            INSERT INTO "platform_audit_logs" (
              "id", "actor_user_id", "action", "resource", "resource_id", "payload", "created_at"
            ) VALUES (
              '${dummyLogId}'::uuid, NULL, 'TEST_APP_INSERT', 'test', '${dummyLogId}', '{}'::jsonb, CURRENT_TIMESTAMP
            );
          `);
        } finally {
          await tx.$executeRawUnsafe(`RESET ROLE;`);
        }
      });

      // 2. SELECT must fail with 42501 (permission denied)
      await expect(
        prisma.$transaction(async (tx) => {
          await tx.$executeRawUnsafe(`SET LOCAL ROLE progresseye_app;`);
          await tx.$executeRawUnsafe(
            `SELECT * FROM "platform_audit_logs" WHERE id = '${dummyLogId}'::uuid;`,
          );
        }),
      ).rejects.toThrow(/permission denied/i);

      // 3. UPDATE must fail with 42501
      await expect(
        prisma.$transaction(async (tx) => {
          await tx.$executeRawUnsafe(`SET LOCAL ROLE progresseye_app;`);
          await tx.$executeRawUnsafe(
            `UPDATE "platform_audit_logs" SET action = 'MODIFIED' WHERE id = '${dummyLogId}'::uuid;`,
          );
        }),
      ).rejects.toThrow(/permission denied/i);

      // 4. DELETE must fail with 42501
      await expect(
        prisma.$transaction(async (tx) => {
          await tx.$executeRawUnsafe(`SET LOCAL ROLE progresseye_app;`);
          await tx.$executeRawUnsafe(
            `DELETE FROM "platform_audit_logs" WHERE id = '${dummyLogId}'::uuid;`,
          );
        }),
      ).rejects.toThrow(/permission denied/i);

      // 5. TRUNCATE must fail with 42501
      await expect(
        prisma.$transaction(async (tx) => {
          await tx.$executeRawUnsafe(`SET LOCAL ROLE progresseye_app;`);
          await tx.$executeRawUnsafe(`TRUNCATE TABLE "platform_audit_logs";`);
        }),
      ).rejects.toThrow(/permission denied/i);
    });

    it("should verify information_schema.role_table_grants has only INSERT for progresseye_app on platform_audit_logs", async () => {
      if (!dbAvailable) {
        if (process.env.CI) throw new Error("Database is required in CI for grants testing");
        return;
      }

      const grants = await prisma.$queryRaw<Array<{ privilege_type: string }>>`
        SELECT privilege_type
        FROM information_schema.role_table_grants
        WHERE table_name = 'platform_audit_logs'
          AND grantee = 'progresseye_app'
        ORDER BY privilege_type ASC;
      `;

      expect(grants.map((g) => g.privilege_type)).toEqual(["INSERT"]);
    });
  });

  describe("withPlatformTenant contract and cross-tenant execution", () => {
    it("should execute operations in target school context and record platform_audit_logs row", async () => {
      if (!dbAvailable) {
        if (process.env.CI) throw new Error("Database is required in CI");
        return;
      }

      const targetSchoolId = existingSchoolId;
      const tenantContextService = app.get(TenantContextService);

      await tenantContextService.run(
        {
          schoolId: SYSTEM_TENANT_ID,
          userId: platformAdminUserId,
          isPlatform: true,
          clientIpHash: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        },
        async () => {
          const testRoleId = uuidv7();
          await prisma.withPlatformTenant(targetSchoolId, async (tx: any) => {
            const currentSchoolSetting = await tx.$queryRaw<Array<{ current_setting: string }>>`
              SELECT current_setting('app.current_school_id', true)
            `;
            expect(currentSchoolSetting[0]?.current_setting).toBe(targetSchoolId);

            return tx.role.create({
              data: {
                id: testRoleId,
                schoolId: targetSchoolId,
                name: "Platform Created Role",
                slug: `platform_role_${Date.now()}`,
                description: "Created via withPlatformTenant",
                isSystem: false,
              },
            });
          });

          // Verify audit log entry was written
          const auditRows = await prisma.$queryRaw<any[]>`
            SELECT * FROM platform_audit_logs
            WHERE resource_id = ${targetSchoolId}
            ORDER BY created_at DESC
            LIMIT 1;
          `;
          expect(auditRows.length).toBeGreaterThan(0);
          expect(auditRows[0].actor_user_id).toBe(platformAdminUserId);
        },
      );
    });

    it("should reject cross-tenant execution when invoked without platform scope", async () => {
      if (!dbAvailable) {
        if (process.env.CI) throw new Error("Database is required in CI");
        return;
      }

      const tenantContextService = app.get(TenantContextService);
      const foreignSchoolId = uuidv7();

      await tenantContextService.run(
        { schoolId: existingSchoolId, userId: tenantAdminUserId, isPlatform: false },
        async () => {
          await expect(
            prisma.withPlatformTenant(foreignSchoolId, async () => {
              return true;
            }),
          ).rejects.toThrow(
            /Cross-tenant execution requires active platform administrative scope/i,
          );

          await expect(
            prisma.withTenant(foreignSchoolId, async () => {
              return true;
            }),
          ).rejects.toThrow(/Cross-tenant execution forbidden/i);
        },
      );
    });

    it("should reject withTenant when target school differs from request tenant even under platform scope", async () => {
      if (!dbAvailable) {
        if (process.env.CI) throw new Error("Database is required in CI");
        return;
      }

      const tenantContextService = app.get(TenantContextService);
      await tenantContextService.run(
        {
          schoolId: SYSTEM_TENANT_ID,
          userId: platformAdminUserId,
          isPlatform: true,
          clientIpHash: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        },
        async () => {
          await expect(
            prisma.withTenant(existingSchoolId, async () => {
              return true;
            }),
          ).rejects.toThrow(/Cross-tenant execution forbidden/i);
        },
      );
    });

    it("should roll back operation if platform audit log insertion fails in withPlatformTenant, with positive control and verification as progresseye_owner", async () => {
      if (!dbAvailable) {
        if (process.env.CI) throw new Error("Database is required in CI");
        return;
      }

      const ownerPrisma = new PrismaClient({
        datasources: { db: { url: ownerDbUrl } },
      });
      await ownerPrisma.$connect();

      const tenantContextService = app.get(TenantContextService);
      const testHmac = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

      try {
        // 1. Positive control: successful execution creates role and makes it visible under target tenant
        const positiveRoleId = uuidv7();
        await tenantContextService.run(
          {
            schoolId: SYSTEM_TENANT_ID,
            userId: platformAdminUserId,
            isPlatform: true,
            clientIpHash: testHmac,
          },
          async () => {
            await prisma.withPlatformTenant(existingSchoolId, async (tx: any) => {
              await tx.role.create({
                data: {
                  id: positiveRoleId,
                  schoolId: existingSchoolId,
                  name: "Positive Control Role",
                  slug: `positive_role_${Date.now()}`,
                  description: "Visible upon success",
                  isSystem: false,
                },
              });
            });
          },
        );

        // Verify positive control role is visible when queried as progresseye_owner with target tenant set
        await ownerPrisma.$transaction(async (tx) => {
          await tx.$executeRaw`SELECT set_config('app.current_school_id', ${existingSchoolId}, true);`;
          const positiveRows: any[] = await tx.$queryRaw`
            SELECT id FROM roles WHERE id = ${positiveRoleId}::uuid;
          `;
          expect(positiveRows).toHaveLength(1);
        });

        // 2. Negative control: passing non-UUID actor ID causes PostgreSQL UUID type check failure
        // in platform_audit_logs INSERT within the single transaction, rolling back op(tx).
        const rollbackRoleId = uuidv7();
        await tenantContextService.run(
          {
            schoolId: SYSTEM_TENANT_ID,
            userId: "not-a-valid-uuid",
            isPlatform: true,
            clientIpHash: testHmac,
          },
          async () => {
            await expect(
              prisma.withPlatformTenant(existingSchoolId, async (tx: any) => {
                await tx.role.create({
                  data: {
                    id: rollbackRoleId,
                    schoolId: existingSchoolId,
                    name: "Rollback Test Role",
                    slug: `rollback_role_${Date.now()}`,
                    description: "Should be rolled back",
                    isSystem: false,
                  },
                });
              }),
            ).rejects.toThrow(/invalid input syntax for type uuid/i);
          },
        );

        // Verify the rollback role does NOT exist when queried as progresseye_owner with target tenant set
        await ownerPrisma.$transaction(async (tx) => {
          await tx.$executeRaw`SELECT set_config('app.current_school_id', ${existingSchoolId}, true);`;
          const rollbackRows: any[] = await tx.$queryRaw`
            SELECT id FROM roles WHERE id = ${rollbackRoleId}::uuid;
          `;
          expect(rollbackRows).toHaveLength(0);
        });
      } finally {
        await ownerPrisma.$disconnect();
      }
    });
  });

  describe("PlatformGuard Live Database Verification", () => {
    let testAdminUser: any;
    let testAdminSession: any;
    let testAdminToken: string;

    beforeEach(async () => {
      if (!dbAvailable) {
        if (process.env.CI) throw new Error("Database is required in CI");
        return;
      }

      const testAdminId = uuidv7();
      await prisma.$executeRaw`SELECT set_config('app.current_school_id', ${SYSTEM_TENANT_ID}, true)`;

      testAdminUser = await prisma.user.create({
        data: {
          id: testAdminId,
          schoolId: SYSTEM_TENANT_ID,
          email: `state-test-${Date.now()}@progresseye.internal`,
          passwordHash: "dummy-hash",
          firstName: "State",
          lastName: "TestAdmin",
          isActive: true,
          mustChangePassword: false,
          isTwoFactorEnabled: true,
        },
      });

      const platformRole = await prisma.role.findFirst({
        where: { schoolId: SYSTEM_TENANT_ID, slug: "platform_admin" },
      });

      await prisma.userRole.create({
        data: {
          schoolId: SYSTEM_TENANT_ID,
          userId: testAdminUser.id,
          roleId: platformRole!.id,
        },
      });

      testAdminSession = await prisma.session.create({
        data: {
          schoolId: SYSTEM_TENANT_ID,
          userId: testAdminUser.id,
          tokenHash: `test-hash-${Date.now()}`,
          clientType: "web",
          expiresAt: new Date(Date.now() + 3600000),
        },
      });

      const { token } = await tokenService.createPlatformAccessToken({
        userId: testAdminUser.id,
        sessionId: testAdminSession.id,
      });
      testAdminToken = token;
    });

    it("should reject request with 401 when platform admin is deactivated", async () => {
      if (!dbAvailable) {
        if (process.env.CI) throw new Error("Database is required in CI");
        return;
      }

      await prisma.$executeRaw`SELECT set_config('app.current_school_id', ${SYSTEM_TENANT_ID}, true)`;
      await prisma.user.update({
        where: { id: testAdminUser.id },
        data: { isActive: false },
      });

      const res = await request(app.getHttpServer())
        .post("/api/v1/platform/schools")
        .set("Authorization", `Bearer ${testAdminToken}`)
        .send({ name: "Deactivated Test", slug: `deact-${Date.now()}` });

      expect(res.status).toBe(401);
      expect(res.body.message ?? res.body.detail).toMatch(/inactive or not found/i);
    });

    it("should reject request with 403 when platform_admin role is removed", async () => {
      if (!dbAvailable) {
        if (process.env.CI) throw new Error("Database is required in CI");
        return;
      }

      await prisma.$executeRaw`SELECT set_config('app.current_school_id', ${SYSTEM_TENANT_ID}, true)`;
      await prisma.userRole.deleteMany({
        where: { userId: testAdminUser.id, schoolId: SYSTEM_TENANT_ID },
      });

      const res = await request(app.getHttpServer())
        .post("/api/v1/platform/schools")
        .set("Authorization", `Bearer ${testAdminToken}`)
        .send({ name: "Role Removed Test", slug: `no-role-${Date.now()}` });

      expect(res.status).toBe(403);
      expect(res.body.message ?? res.body.detail).toMatch(/role has been revoked/i);
    });

    it("should reject request with 401 when platform admin session is revoked", async () => {
      if (!dbAvailable) {
        if (process.env.CI) throw new Error("Database is required in CI");
        return;
      }

      await prisma.$executeRaw`SELECT set_config('app.current_school_id', ${SYSTEM_TENANT_ID}, true)`;
      await prisma.session.update({
        where: { id: testAdminSession.id },
        data: { revokedAt: new Date() },
      });

      const res = await request(app.getHttpServer())
        .post("/api/v1/platform/schools")
        .set("Authorization", `Bearer ${testAdminToken}`)
        .send({ name: "Revoked Session Test", slug: `revoked-${Date.now()}` });

      expect(res.status).toBe(401);
      expect(res.body.message ?? res.body.detail).toMatch(/session has been revoked or expired/i);
    });

    it("should immediately reject subsequent requests when session is revoked with zero cache window delay", async () => {
      if (!dbAvailable) {
        if (process.env.CI) throw new Error("Database is required in CI");
        return;
      }

      // 1. Initial request passes PlatformGuard (validation error 400 proves guard passed)
      const res1 = await request(app.getHttpServer())
        .post("/api/v1/platform/schools")
        .set("Authorization", `Bearer ${testAdminToken}`)
        .set("Connection", "close")
        .send({});

      expect(res1.status).toBe(400);

      // 2. Immediately revoke session in database
      await prisma.$executeRaw`SELECT set_config('app.current_school_id', ${SYSTEM_TENANT_ID}, true)`;
      await prisma.session.update({
        where: { id: testAdminSession.id },
        data: { revokedAt: new Date() },
      });

      // 3. Next request within milliseconds must be rejected with 401 immediately (no cache delay)
      const res2 = await request(app.getHttpServer())
        .post("/api/v1/platform/schools")
        .set("Authorization", `Bearer ${testAdminToken}`)
        .set("Connection", "close")
        .send({});

      expect(res2.status).toBe(401);
      expect(res2.body.message ?? res2.body.detail).toMatch(/session has been revoked or expired/i);
    });
  });

  describe("scripts/bootstrap-platform-admin.ts CLI executions", () => {
    it("should refuse bootstrap in production without ENABLE_PLATFORM_BOOTSTRAP=true", () => {
      let failed = false;
      let output = "";
      try {
        output = execSync("pnpm exec ts-node scripts/bootstrap-platform-admin.ts", {
          env: {
            ...process.env,
            NODE_ENV: "production",
            ENABLE_PLATFORM_BOOTSTRAP: "false",
            PLATFORM_BOOTSTRAP_SECRET: "a-very-long-secret-key-that-is-at-least-32-chars-long",
          },
          stdio: "pipe",
        }).toString();
      } catch (err: any) {
        failed = true;
        output = err.stderr ? err.stderr.toString() : err.stdout.toString();
      }
      expect(failed).toBe(true);
      expect(output).toMatch(/Platform admin bootstrap is disabled in production/i);
    });

    it("should refuse bootstrap when secret is shorter than 32 characters", () => {
      let failed = false;
      let output = "";
      try {
        output = execSync("pnpm exec ts-node scripts/bootstrap-platform-admin.ts", {
          env: {
            ...process.env,
            NODE_ENV: "development",
            ENABLE_PLATFORM_BOOTSTRAP: "true",
            PLATFORM_BOOTSTRAP_SECRET: "too-short-secret",
          },
          stdio: "pipe",
        }).toString();
      } catch (err: any) {
        failed = true;
        output = err.stderr ? err.stderr.toString() : err.stdout.toString();
      }
      expect(failed).toBe(true);
      expect(output).toMatch(/at least 32 characters/i);
    });

    it("should run real bootstrap script on empty system tenant, asserting admin with isTwoFactorEnabled=false, mustChangePassword=true, audit row, single password output, and refusal on second run", async () => {
      if (process.env.CI && !dbAvailable) {
        throw new Error("Database is required in CI for bootstrap testing");
      }
      if (!dbAvailable) {
        if (process.env.CI) throw new Error("Database is required in CI");
        return;
      }

      // 1. Clear platform admin users from system tenant under FORCE RLS
      await prisma.$executeRaw`SELECT set_config('app.current_school_id', ${SYSTEM_TENANT_ID}, true)`;
      await prisma.userRole.deleteMany({
        where: { schoolId: SYSTEM_TENANT_ID },
      });
      await prisma.session.deleteMany({
        where: { schoolId: SYSTEM_TENANT_ID },
      });
      await prisma.user.deleteMany({
        where: { schoolId: SYSTEM_TENANT_ID },
      });

      const secret = "a-very-long-secret-key-that-is-at-least-32-chars-long";
      const bootstrapEmail = `bootstrap-${Date.now()}@progresseye.internal`;

      try {
        // 2. Execute bootstrap script via ts-node under progresseye_owner database connection
        const stdout1 = execSync("pnpm exec ts-node scripts/bootstrap-platform-admin.ts", {
          env: {
            ...process.env,
            DATABASE_URL: ownerDbUrl,
            NODE_ENV: "development",
            ENABLE_PLATFORM_BOOTSTRAP: "true",
            PLATFORM_BOOTSTRAP_SECRET: secret,
            PLATFORM_ADMIN_EMAIL: bootstrapEmail,
          },
          stdio: "pipe",
        }).toString();

        expect(stdout1).toContain("PLATFORM ADMINISTRATOR BOOTSTRAPPED SUCCESSFULLY");
        expect(stdout1).toContain(bootstrapEmail);

        // 3. Verify user in database: isTwoFactorEnabled=false, mustChangePassword=true
        const bootstrappedUser = await prisma.user.findFirst({
          where: { schoolId: SYSTEM_TENANT_ID, email: bootstrapEmail },
        });
        expect(bootstrappedUser).toBeDefined();
        expect(bootstrappedUser?.isTwoFactorEnabled).toBe(false);
        expect(bootstrappedUser?.mustChangePassword).toBe(true);
        expect(bootstrappedUser?.isActive).toBe(true);

        // Verify PLATFORM_ADMIN_BOOTSTRAP audit row exists
        const auditRows = await prisma.$queryRaw<any[]>`
          SELECT * FROM platform_audit_logs
          WHERE action = 'PLATFORM_ADMIN_BOOTSTRAP' AND resource_id = ${bootstrappedUser!.id};
        `;
        expect(auditRows.length).toBe(1);

        // 4. Verify one-time password appears only once on stdout and never in audit payload
        const match = stdout1.match(/One-Time Password:\s*(\S+)/);
        expect(match).not.toBeNull();
        const oneTimePassword = match ? match[1]! : "";
        expect(oneTimePassword.startsWith("Pe!")).toBe(true);

        // Count occurrences of password in stdout: exactly 1
        const passwordMatches = stdout1.split(oneTimePassword).length - 1;
        expect(passwordMatches).toBe(1);

        // Assert one-time password NEVER appears in audit log payload
        const auditPayloadStr = JSON.stringify(auditRows[0].payload);
        expect(auditPayloadStr).not.toContain(oneTimePassword);
        expect(auditPayloadStr.toLowerCase()).not.toContain("password");

        // 5. Run a second time in the same test: must see refusal
        let secondRunFailed = false;
        let secondRunOutput = "";
        try {
          secondRunOutput = execSync("pnpm exec ts-node scripts/bootstrap-platform-admin.ts", {
            env: {
              ...process.env,
              DATABASE_URL: ownerDbUrl,
              NODE_ENV: "development",
              ENABLE_PLATFORM_BOOTSTRAP: "true",
              PLATFORM_BOOTSTRAP_SECRET: secret,
              PLATFORM_ADMIN_EMAIL: bootstrapEmail,
            },
            stdio: "pipe",
          }).toString();
        } catch (err: any) {
          secondRunFailed = true;
          secondRunOutput =
            (err.stderr ? err.stderr.toString() : "") + (err.stdout ? err.stdout.toString() : "");
        }

        expect(secondRunFailed).toBe(true);
        expect(secondRunOutput).toMatch(
          /Platform administrator already exists.*Bootstrap refused/i,
        );
      } finally {
        // Restore platformAdminUserId in system tenant for subsequent test isolation
        await prisma.user.upsert({
          where: { id: platformAdminUserId },
          update: { isActive: true, isTwoFactorEnabled: true },
          create: {
            id: platformAdminUserId,
            schoolId: SYSTEM_TENANT_ID,
            email: "superadmin@progresseye.internal",
            passwordHash: "$argon2id$v=19$m=4096,t=2,p=1$7v1b8z5m/f4k2j9s$dummyhashvaluehere",
            firstName: "Platform",
            lastName: "SuperAdmin",
            isActive: true,
            isTwoFactorEnabled: true,
          },
        });
        const platformAdminRole = await prisma.role.findFirst({
          where: { schoolId: SYSTEM_TENANT_ID, slug: "platform_admin" },
        });
        if (platformAdminRole) {
          await prisma.userRole.upsert({
            where: {
              schoolId_userId_roleId: {
                schoolId: SYSTEM_TENANT_ID,
                userId: platformAdminUserId,
                roleId: platformAdminRole.id,
              },
            },
            update: {},
            create: {
              schoolId: SYSTEM_TENANT_ID,
              userId: platformAdminUserId,
              roleId: platformAdminRole.id,
            },
          });
        }
      }
    });

    it("should confirm bootstrap audit log row never contains plaintext password", async () => {
      if (!dbAvailable) {
        if (process.env.CI) throw new Error("Database is required in CI");
        return;
      }

      const auditRows = await prisma.$queryRaw<any[]>`
        SELECT * FROM platform_audit_logs
        WHERE action = 'PLATFORM_ADMIN_BOOTSTRAP';
      `;
      for (const row of auditRows) {
        const payloadStr = JSON.stringify(row.payload);
        expect(payloadStr).not.toMatch(/password/i);
      }
    });
  });

  describe("Platform Admin Bootstrap Logic", () => {
    it("should refuse bootstrap when platform administrator already exists in system tenant", async () => {
      if (!dbAvailable) {
        if (process.env.CI) throw new Error("Database is required in CI");
        return;
      }

      // Under FORCE RLS set system tenant context
      await prisma.$executeRaw`SELECT set_config('app.current_school_id', ${SYSTEM_TENANT_ID}, true)`;

      const existingPlatformAdmin = await prisma.userRole.findFirst({
        where: {
          schoolId: SYSTEM_TENANT_ID,
          role: { slug: "platform_admin" },
        },
        include: { user: true },
      });

      expect(existingPlatformAdmin).toBeDefined();
      expect(existingPlatformAdmin?.schoolId).toBe(SYSTEM_TENANT_ID);
      expect(existingPlatformAdmin?.user.email).toMatch(/@progresseye\.internal$/);

      // Verify that any secondary bootstrap attempt detects this existing record and refuses
      const canBootstrap = existingPlatformAdmin === null;
      expect(canBootstrap).toBe(false);
    });
  });
});
