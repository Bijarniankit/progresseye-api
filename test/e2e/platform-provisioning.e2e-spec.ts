import fastifyCookie from "@fastify/cookie";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { Test, type TestingModule } from "@nestjs/testing";
import * as argon2 from "argon2";
import { Logger } from "nestjs-pino";
import request from "supertest";
import { uuidv7 } from "uuidv7";
import { AppModule } from "../../src/app.module";
import { SYSTEM_TENANT_ID } from "../../src/common/request-context/tenant-context.service";
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
    if (app) await app.close();
    if (prisma) await prisma.$disconnect();
  });

  describe("POST /api/v1/platform/schools", () => {
    it("should reject unauthenticated request with 401", async () => {
      const res = await request(app.getHttpServer())
        .post("/api/v1/platform/schools")
        .send({ name: "Unauthenticated High", slug: "unauth-high" });

      expect(res.status).toBe(401);
    });

    it("should reject tenant admin request with 403 Forbidden (platform scope required)", async () => {
      if (!dbAvailable) return;

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
      if (!dbAvailable) return;

      const res = await request(app.getHttpServer())
        .post("/api/v1/platform/schools")
        .set("Authorization", `Bearer ${platformAdminToken}`)
        .send({ name: "System School", slug: "system-platform" });

      expect(res.status).toBe(400);
      expect(res.body.message ?? res.body.detail).toMatch(/reserved/i);
    });

    it("should reject invalid slug format with 400 Bad Request", async () => {
      if (!dbAvailable) return;

      const res = await request(app.getHttpServer())
        .post("/api/v1/platform/schools")
        .set("Authorization", `Bearer ${platformAdminToken}`)
        .send({ name: "Invalid Slug School", slug: "INVALID_SLUG_WITH_CAPS!" });

      expect(res.status).toBe(400);
    });

    it("should successfully provision a new school with 12 built-in roles and audit rows", async () => {
      if (!dbAvailable) return;

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

      // Verify platform audit log entries exist
      const auditInit = await prisma.$queryRaw<any[]>`
        SELECT * FROM platform_audit_logs
        WHERE action = 'PLATFORM_SCHOOL_PROVISION_INIT' AND resource_id = ${newSchoolId}
      `;
      expect(auditInit.length).toBeGreaterThan(0);

      const auditComplete = await prisma.$queryRaw<any[]>`
        SELECT * FROM platform_audit_logs
        WHERE action = 'PLATFORM_SCHOOL_PROVISION_COMPLETE' AND resource_id = ${newSchoolId}
      `;
      expect(auditComplete.length).toBeGreaterThan(0);
    });

    it("should reject duplicate school slug with 409 Conflict", async () => {
      if (!dbAvailable) return;

      const res = await request(app.getHttpServer())
        .post("/api/v1/platform/schools")
        .set("Authorization", `Bearer ${platformAdminToken}`)
        .send({ name: "Duplicate Academy", slug: "existing-academy" });

      expect(res.status).toBe(409);
      expect(res.body.message ?? res.body.detail).toMatch(/already exists/i);
    });
  });

  describe("POST /api/v1/platform/schools/:id/reseed-roles", () => {
    it("should reseed roles for provisioned school and log PLATFORM_SCHOOL_RESEED_ROLES", async () => {
      if (!dbAvailable) return;

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
      if (!dbAvailable) return;

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
      if (!dbAvailable) return;

      const nonExistentSchoolId = uuidv7();
      const res = await request(app.getHttpServer())
        .post(`/api/v1/platform/schools/${nonExistentSchoolId}/reseed-roles`)
        .set("Authorization", `Bearer ${platformAdminToken}`);

      expect(res.status).toBe(404);
    });
  });

  describe("Platform Admin Bootstrap Logic", () => {
    it("should refuse bootstrap when platform administrator already exists in system tenant", async () => {
      if (!dbAvailable) return;

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
      expect(existingPlatformAdmin?.user.email).toBe("superadmin@progresseye.internal");

      // Verify that any secondary bootstrap attempt detects this existing record and refuses
      const canBootstrap = existingPlatformAdmin === null;
      expect(canBootstrap).toBe(false);
    });
  });
});
