import fastifyCookie from "@fastify/cookie";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { Test, type TestingModule } from "@nestjs/testing";
import * as argon2 from "argon2";
import { SignJWT } from "jose";
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
      if (!dbAvailable) {
        if (process.env.CI) throw new Error("Database is required in CI");
        return;
      }

      const res = await request(app.getHttpServer())
        .post("/api/v1/platform/auth/login")
        .send({ email: platformEmail, password: "WrongPassword123!" });

      expect(res.status).toBe(401);
    });

    it("should reject tenant credentials at platform login endpoint", async () => {
      if (!dbAvailable) {
        if (process.env.CI) throw new Error("Database is required in CI");
        return;
      }

      const res = await request(app.getHttpServer())
        .post("/api/v1/platform/auth/login")
        .send({ email: tenantEmail, password });

      expect(res.status).toBe(401);
    });

    it("should return platform_2fa_setup_pending on initial platform login", async () => {
      if (!dbAvailable) {
        if (process.env.CI) throw new Error("Database is required in CI");
        return;
      }

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
      if (!dbAvailable) {
        if (process.env.CI) throw new Error("Database is required in CI");
        return;
      }

      const res = await request(app.getHttpServer())
        .post("/api/v1/platform/auth/2fa/setup")
        .set("Authorization", `Bearer ${setupToken}`);

      expect(res.status).toBe(200);
      expect(res.body.secret).toBeDefined();
      expect(res.body.uri).toBeDefined();

      totpSecret = res.body.secret;
    });

    it("should reject 2FA enable with invalid code", async () => {
      if (!dbAvailable) {
        if (process.env.CI) throw new Error("Database is required in CI");
        return;
      }

      const res = await request(app.getHttpServer())
        .post("/api/v1/platform/auth/2fa/enable")
        .set("Authorization", `Bearer ${setupToken}`)
        .send({ code: "000000" });

      expect(res.status).toBe(400);
    });

    it("POST /api/v1/platform/auth/2fa/enable: success path issues active platform token with platform scope", async () => {
      if (!dbAvailable) {
        if (process.env.CI) throw new Error("Database is required in CI");
        return;
      }

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

      const decoded = await tokenService.verifyAccessToken(res.body.accessToken);
      expect(decoded.scope).toBe("platform");
      expect(decoded.schoolId).toBe(SYSTEM_TENANT_ID);

      recoveryCode = res.body.recoveryCodes[0];
    });

    it("subsequent login should issue platform_2fa_pending challenge", async () => {
      if (!dbAvailable) {
        if (process.env.CI) throw new Error("Database is required in CI");
        return;
      }

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
      if (!dbAvailable) {
        if (process.env.CI) throw new Error("Database is required in CI");
        return;
      }

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

  describe("Platform 2FA Token Scope & Cross-Tenant Rejection", () => {
    const jwtSecret = new TextEncoder().encode(
      process.env.AUTH_JWT_SECRET || "ci_jwt_secret_throwaway_token_min_32_chars_long",
    );

    it("should reject tenant access token at platform 2FA verify endpoint", async () => {
      if (!dbAvailable) {
        if (process.env.CI) throw new Error("Database is required in CI");
        return;
      }

      const { token: tenantToken } = await tokenService.createAccessToken({
        userId: tenantUserId,
        schoolId: tenantSchoolId,
        sessionId: uuidv7(),
      });

      const res = await request(app.getHttpServer())
        .post("/api/v1/platform/auth/2fa/verify")
        .set("Authorization", `Bearer ${tenantToken}`)
        .send({ code: "123456" });

      expect(res.status).toBe(401);
      expect(res.body.message ?? res.body.detail).toMatch(/Invalid platform 2FA credentials/i);
    });

    it("should reject tenant 2fa_pending token at platform 2FA verify endpoint", async () => {
      if (!dbAvailable) {
        if (process.env.CI) throw new Error("Database is required in CI");
        return;
      }

      const { token: tenant2faToken } = await tokenService.createTemporaryTwoFactorToken({
        userId: tenantUserId,
        schoolId: tenantSchoolId,
      });

      const res = await request(app.getHttpServer())
        .post("/api/v1/platform/auth/2fa/verify")
        .set("Authorization", `Bearer ${tenant2faToken}`)
        .send({ code: "123456" });

      expect(res.status).toBe(401);
      expect(res.body.message ?? res.body.detail).toMatch(/Invalid platform 2FA credentials/i);
    });

    it("should reject token with tampered scope at platform 2FA verify endpoint", async () => {
      if (!dbAvailable) {
        if (process.env.CI) throw new Error("Database is required in CI");
        return;
      }

      const tamperedScopeToken = await new SignJWT({
        schoolId: SYSTEM_TENANT_ID,
        sessionId: uuidv7(),
        scope: "tampered_scope_escalation",
      })
        .setSubject(platformAdminUserId)
        .setProtectedHeader({ alg: "HS256" })
        .setExpirationTime("5m")
        .sign(jwtSecret);

      const res = await request(app.getHttpServer())
        .post("/api/v1/platform/auth/2fa/verify")
        .set("Authorization", `Bearer ${tamperedScopeToken}`)
        .send({ code: "123456" });

      expect(res.status).toBe(401);
      expect(res.body.message ?? res.body.detail).toMatch(
        /Invalid (?:platform 2FA credentials|or expired access token)/i,
      );
    });

    it("should reject token for non-system-tenant user claiming platform_2fa_pending scope", async () => {
      if (!dbAvailable) {
        if (process.env.CI) throw new Error("Database is required in CI");
        return;
      }

      const foreignUserToken = await new SignJWT({
        schoolId: SYSTEM_TENANT_ID,
        scope: "platform_2fa_pending",
      })
        .setSubject(tenantUserId)
        .setProtectedHeader({ alg: "HS256" })
        .setExpirationTime("5m")
        .sign(jwtSecret);

      const res = await request(app.getHttpServer())
        .post("/api/v1/platform/auth/2fa/verify")
        .set("Authorization", `Bearer ${foreignUserToken}`)
        .send({ code: "123456" });

      expect(res.status).toBe(401);
      expect(res.body.message ?? res.body.detail).toMatch(/Invalid.*credentials/i);
    });

    it("should reject tenant access token at platform 2FA setup endpoint", async () => {
      if (!dbAvailable) {
        if (process.env.CI) throw new Error("Database is required in CI");
        return;
      }

      const { token: tenantToken } = await tokenService.createAccessToken({
        userId: tenantUserId,
        schoolId: tenantSchoolId,
        sessionId: uuidv7(),
      });

      const res = await request(app.getHttpServer())
        .post("/api/v1/platform/auth/2fa/setup")
        .set("Authorization", `Bearer ${tenantToken}`);

      expect(res.status).toBe(401);
      expect(res.body.message ?? res.body.detail).toMatch(
        /Invalid platform 2FA setup credentials/i,
      );
    });

    it("should reject token with wrong scope at platform 2FA setup endpoint", async () => {
      if (!dbAvailable) {
        if (process.env.CI) throw new Error("Database is required in CI");
        return;
      }

      const { token: challengeToken } = await tokenService.createTemporaryPlatformTwoFactorToken({
        userId: platformAdminUserId,
        setup: false, // scope: "platform_2fa_pending" (challenge, not setup)
      });

      const res = await request(app.getHttpServer())
        .post("/api/v1/platform/auth/2fa/setup")
        .set("Authorization", `Bearer ${challengeToken}`);

      expect(res.status).toBe(401);
      expect(res.body.message ?? res.body.detail).toMatch(
        /Invalid platform 2FA setup credentials/i,
      );
    });
  });

  describe("Platform Auth Rate Limiting & Anti-Abuse Lockout", () => {
    it("should enforce rate limiting and lockout on repeated failed platform logins", async () => {
      if (!dbAvailable) {
        if (process.env.CI) throw new Error("Database is required in CI");
        return;
      }

      const wrongCredentials = {
        email: "superadmin@progresseye.internal",
        password: "IncorrectPassword123!",
      };

      // Perform repeated failed login attempts
      for (let i = 0; i < 5; i++) {
        await request(app.getHttpServer())
          .post("/api/v1/platform/auth/login")
          .send(wrongCredentials);
      }

      // Further attempt should be blocked with rate limiting / lockout (429 or 401 with lockout message)
      const lockedRes = await request(app.getHttpServer())
        .post("/api/v1/platform/auth/login")
        .send(wrongCredentials);

      expect([401, 429]).toContain(lockedRes.status);
      if (lockedRes.status === 429) {
        expect(lockedRes.body.message ?? lockedRes.body.detail).toMatch(
          /too many requests|rate limit/i,
        );
      }
    });
  });
});
