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
import { TotpService } from "../../src/modules/identity/domain/totp.service";

jest.setTimeout(45000);

describe("Phase 13b-1: Platform Auth E2E Suite", () => {
  let app: NestFastifyApplication;
  let prisma: PrismaService;
  let roleService: RoleService;
  let tokenService: TokenService;
  let totpService: TotpService;
  let dbAvailable = false;

  const platformAdminUserId = uuidv7();
  const tenantUserId = uuidv7();
  const tenantSchoolId = uuidv7();

  const platformEmail = "platform.login.test@progresseye.internal";
  const tenantEmail = "teacher@school.internal";
  const password = "PlatformSecurePass123!";

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
    totpService = moduleFixture.get<TotpService>(TotpService);

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

      await roleService.seedBuiltInRolesForSchool(SYSTEM_TENANT_ID);

      const passwordHash = await argon2.hash(password, {
        type: argon2.argon2id,
        memoryCost: 4096,
        timeCost: 2,
        parallelism: 1,
      });

      // Platform admin user without 2FA initially (fresh setup flow)
      await prisma.user.upsert({
        where: { id: platformAdminUserId },
        update: {},
        create: {
          id: platformAdminUserId,
          schoolId: SYSTEM_TENANT_ID,
          email: platformEmail,
          passwordHash,
          firstName: "Platform",
          lastName: "Tester",
          isActive: true,
          isTwoFactorEnabled: false,
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

      // Tenant school and tenant user
      await prisma.school.upsert({
        where: { id: tenantSchoolId },
        update: {},
        create: {
          id: tenantSchoolId,
          name: "Tenant School Alpha",
          slug: "tenant-school-alpha",
          isActive: true,
        },
      });

      await prisma.user.upsert({
        where: { id: tenantUserId },
        update: {},
        create: {
          id: tenantUserId,
          schoolId: tenantSchoolId,
          email: tenantEmail,
          passwordHash,
          firstName: "Tenant",
          lastName: "Teacher",
          isActive: true,
          isTwoFactorEnabled: true,
        },
      });
    }

    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    if (app) await app.close();
    if (prisma) await prisma.$disconnect();
  });

  describe("Platform Auth End-to-End Flow", () => {
    let setupToken = "";
    let totpSecret = "";
    let recoveryCode = "";
    let verifyToken = "";

    it("should reject platform login with wrong password", async () => {
      if (!dbAvailable) return;

      const res = await request(app.getHttpServer())
        .post("/api/v1/platform/auth/login")
        .send({ email: platformEmail, password: "WrongPassword123!" });

      expect(res.status).toBe(401);
    });

    it("should reject tenant credentials at platform login endpoint", async () => {
      if (!dbAvailable) return;

      const res = await request(app.getHttpServer())
        .post("/api/v1/platform/auth/login")
        .send({ email: tenantEmail, password });

      expect(res.status).toBe(401);
    });

    it("should return platform_2fa_setup_pending on initial platform login", async () => {
      if (!dbAvailable) return;

      const res = await request(app.getHttpServer())
        .post("/api/v1/platform/auth/login")
        .send({ email: platformEmail, password });

      expect(res.status).toBe(200);
      expect(res.body.requires2Fa).toBe(true);
      expect(res.body.scope).toBe("platform_2fa_setup_pending");
      expect(res.body.temporaryToken).toBeDefined();

      setupToken = res.body.temporaryToken;
    });

    it("should initialize 2FA setup with platform_2fa_setup_pending token", async () => {
      if (!dbAvailable) return;

      const res = await request(app.getHttpServer())
        .post("/api/v1/platform/auth/2fa/setup")
        .set("Authorization", `Bearer ${setupToken}`);

      expect(res.status).toBe(200);
      expect(res.body.secret).toBeDefined();
      expect(res.body.uri).toBeDefined();

      totpSecret = res.body.secret;
    });

    it("should reject 2FA enable with invalid code", async () => {
      if (!dbAvailable) return;

      const res = await request(app.getHttpServer())
        .post("/api/v1/platform/auth/2fa/enable")
        .set("Authorization", `Bearer ${setupToken}`)
        .send({ code: "000000" });

      expect(res.status).toBe(400);
    });

    it("should enable 2FA with valid TOTP code and return platform access session", async () => {
      if (!dbAvailable) return;

      const validCode = totpService.generateCode(totpSecret);
      const res = await request(app.getHttpServer())
        .post("/api/v1/platform/auth/2fa/enable")
        .set("Authorization", `Bearer ${setupToken}`)
        .send({ code: validCode });

      expect(res.status).toBe(200);
      expect(res.body.accessToken).toBeDefined();
      expect(res.body.tokenType).toBe("Bearer");
      expect(Array.isArray(res.body.recoveryCodes)).toBe(true);
      expect(res.body.recoveryCodes.length).toBeGreaterThan(0);

      recoveryCode = res.body.recoveryCodes[0];
    });

    it("subsequent login should issue platform_2fa_pending challenge", async () => {
      if (!dbAvailable) return;

      const res = await request(app.getHttpServer())
        .post("/api/v1/platform/auth/login")
        .send({ email: platformEmail, password });

      expect(res.status).toBe(200);
      expect(res.body.requires2Fa).toBe(true);
      expect(res.body.scope).toBe("platform_2fa_pending");
      expect(res.body.temporaryToken).toBeDefined();

      verifyToken = res.body.temporaryToken;
    });

    it("should complete login verification using recovery code", async () => {
      if (!dbAvailable) return;

      const res = await request(app.getHttpServer())
        .post("/api/v1/platform/auth/2fa/verify")
        .set("Authorization", `Bearer ${verifyToken}`)
        .send({ code: recoveryCode });

      expect(res.status).toBe(200);
      expect(res.body.accessToken).toBeDefined();
      expect(res.body.tokenType).toBe("Bearer");

      // Verify the returned token has scope "platform"
      const claims = await tokenService.verifyAccessToken(res.body.accessToken);
      expect(claims.scope).toBe("platform");
      expect(claims.schoolId).toBe(SYSTEM_TENANT_ID);
    });
  });
});
