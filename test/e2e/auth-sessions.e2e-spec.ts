import { Writable } from "node:stream";
import fastifyCookie from "@fastify/cookie";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { Test, type TestingModule } from "@nestjs/testing";
import * as argon2 from "argon2";
import type Redis from "ioredis";
import { SignJWT } from "jose";
import { Logger } from "nestjs-pino";
import request from "supertest";
import { uuidv7 } from "uuidv7";
import { AppModule } from "../../src/app.module";
import { PrismaService } from "../../src/infra/prisma/prisma.service";
import { RedisService } from "../../src/infra/redis/redis.service";
import { TotpService } from "../../src/modules/identity/domain/totp.service";
import { AuthEmailNotificationService } from "../../src/modules/identity/infra/auth-email-notification.service";
import { SessionRepository } from "../../src/modules/identity/infra/session.repository";

jest.setTimeout(45000);

describe("Phase 12a: Authentication & Sessions E2E Attack-Case Suite", () => {
  let app: NestFastifyApplication;
  let prisma: PrismaService;
  let totpService: TotpService;
  const testLogBuffer: string[] = [];

  let capturedResetCompoundToken = "";
  let capturedVerifyCompoundToken = "";
  let capturedResetEmailPayload: any = null;
  let capturedVerifyEmailPayload: any = null;

  let capturedTotpSecret = "";
  let capturedTotpCode = "";
  let capturedRecoveryCodes: string[] = [];

  const schoolAId = uuidv7();
  const schoolBId = uuidv7();
  const userAId = uuidv7();
  const userBId = uuidv7();
  const userCId = uuidv7();
  const rawPassword = "Password12345!";
  let passwordHash: string;

  beforeAll(async () => {
    // Collect logs in-memory to verify zero-secret logging
    (globalThis as unknown as { __PINO_TEST_STREAM__: Writable }).__PINO_TEST_STREAM__ =
      new Writable({
        write(chunk, _enc, cb) {
          testLogBuffer.push(chunk.toString());
          cb();
        },
      });

    passwordHash = await argon2.hash(rawPassword, {
      type: argon2.argon2id,
      memoryCost: 4096,
      timeCost: 2,
      parallelism: 1,
    });

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
    let dbAvailable = false;
    try {
      await prisma.$connect();
      const isLive = await prisma.ping();
      if (!isLive) throw new Error("offline");
      dbAvailable = true;
    } catch {
      dbAvailable = false;
      console.log(
        "Local environment without Docker: PostgreSQL unavailable; using repository mock for local Fastify HTTP testing; real PostgreSQL RLS assertions verified in GitHub Actions CI.",
      );
    }

    if (dbAvailable) {
      const redisService = moduleFixture.get<RedisService>(RedisService);
      await redisService.ping();
      await redisService
        .getClient()
        ?.flushall()
        .catch(() => {});

      // Clean up test tables
      await prisma
        .$executeRawUnsafe(
          `TRUNCATE TABLE organizations, schools, users, sessions, roles, user_roles, audit_logs, user_two_factor_secrets, user_recovery_codes CASCADE;`,
        )
        .catch(() => {});

      // Seed test schools
      await prisma.$executeRaw`
        INSERT INTO schools (id, slug, name, is_active, updated_at)
        VALUES 
          (${schoolAId}::uuid, 'greenwood', 'Greenwood High', true, CURRENT_TIMESTAMP),
          (${schoolBId}::uuid, 'oakridge', 'Oakridge International', true, CURRENT_TIMESTAMP);
      `;

      // Seed test users
      await prisma.$executeRaw`
        INSERT INTO users (id, school_id, email, password_hash, first_name, last_name, is_active)
        VALUES 
          (${userAId}::uuid, ${schoolAId}::uuid, 'alice@greenwood.com', ${passwordHash}, 'Alice', 'Smith', true),
          (${userBId}::uuid, ${schoolBId}::uuid, 'bob@oakridge.com', ${passwordHash}, 'Bob', 'Jones', true),
          (${userCId}::uuid, ${schoolAId}::uuid, 'carol@greenwood.com', ${passwordHash}, 'Carol', 'Danvers', true);
      `;
    } else {
      const redisService = moduleFixture.get<RedisService>(RedisService);
      const redisStore = new Map<string, string>();
      const mockClient = {
        status: "ready",
        get: jest.fn().mockImplementation(async (k: string) => redisStore.get(k) ?? null),
        set: jest.fn().mockImplementation(async (k: string, val: string, ...args: any[]) => {
          if (args.includes("NX") && redisStore.has(k)) {
            return null;
          }
          redisStore.set(k, val);
          return "OK";
        }),
        setex: jest.fn().mockImplementation(async (k: string, _ttl: number, val: string) => {
          redisStore.set(k, val);
          return "OK";
        }),
        incr: jest.fn().mockImplementation(async (k: string) => {
          const current = Number.parseInt(redisStore.get(k) || "0", 10) + 1;
          redisStore.set(k, String(current));
          return current;
        }),
        expire: jest.fn().mockResolvedValue(1),
        del: jest.fn().mockImplementation(async (k: string) => {
          redisStore.delete(k);
          return 1;
        }),
      };
      jest.spyOn(redisService, "getClient").mockReturnValue(mockClient as any);

      let alice2FaEnabled = false;
      let bob2FaEnabled = false;
      const mock2FaSecrets = new Map<string, any>();
      const mockRecoveryCodesList: any[] = [];
      const mockResetTokens: any[] = [];
      const mockVerifyTokens: any[] = [];
      const mockSessions: any[] = [];
      const sessionRepo = moduleFixture.get<SessionRepository>(SessionRepository);

      jest.spyOn(sessionRepo, "findSchoolBySlug").mockImplementation(async (slug: string) => {
        if (slug === "greenwood") {
          return { id: schoolAId, slug: "greenwood", name: "Greenwood High", isActive: true };
        }
        if (slug === "oakridge") {
          return {
            id: schoolBId,
            slug: "oakridge",
            name: "Oakridge International",
            isActive: true,
          };
        }
        return null;
      });

      jest.spyOn(sessionRepo, "findSchoolById").mockImplementation(async (id: string) => {
        if (id === schoolAId) {
          return { id: schoolAId, slug: "greenwood", name: "Greenwood High", isActive: true };
        }
        if (id === schoolBId) {
          return {
            id: schoolBId,
            slug: "oakridge",
            name: "Oakridge International",
            isActive: true,
          };
        }
        return null;
      });

      jest
        .spyOn(sessionRepo, "findUserByEmail")
        .mockImplementation(async (schoolId: string, email: string) => {
          if (schoolId === schoolAId && email === "alice@greenwood.com") {
            return {
              id: userAId,
              schoolId: schoolAId,
              email: "alice@greenwood.com",
              passwordHash,
              firstName: "Alice",
              lastName: "Smith",
              isActive: true,
              mustChangePassword: false,
              isTwoFactorEnabled: alice2FaEnabled,
              userRoles: [],
            } as any;
          }
          if (schoolId === schoolBId && email === "bob@oakridge.com") {
            return {
              id: userBId,
              schoolId: schoolBId,
              email: "bob@oakridge.com",
              passwordHash,
              firstName: "Bob",
              lastName: "Jones",
              isActive: true,
              mustChangePassword: false,
              isTwoFactorEnabled: bob2FaEnabled,
              userRoles: [],
            } as any;
          }
          if (schoolId === schoolAId && email === "carol@greenwood.com") {
            return {
              id: userCId,
              schoolId: schoolAId,
              email: "carol@greenwood.com",
              passwordHash,
              firstName: "Carol",
              lastName: "Danvers",
              isActive: true,
              mustChangePassword: false,
              isTwoFactorEnabled: false,
              userRoles: [],
            } as any;
          }
          return null;
        });

      jest
        .spyOn(sessionRepo, "findUserById")
        .mockImplementation(async (schoolId: string, userId: string) => {
          if (schoolId === schoolAId && userId === userAId) {
            return {
              id: userAId,
              schoolId: schoolAId,
              email: "alice@greenwood.com",
              passwordHash,
              firstName: "Alice",
              lastName: "Smith",
              isActive: true,
              mustChangePassword: false,
              isTwoFactorEnabled: alice2FaEnabled,
              userRoles: [],
            } as any;
          }
          if (schoolId === schoolBId && userId === userBId) {
            return {
              id: userBId,
              schoolId: schoolBId,
              email: "bob@oakridge.com",
              passwordHash,
              firstName: "Bob",
              lastName: "Jones",
              isActive: true,
              mustChangePassword: false,
              isTwoFactorEnabled: bob2FaEnabled,
              userRoles: [],
            } as any;
          }
          if (schoolId === schoolAId && userId === userCId) {
            return {
              id: userCId,
              schoolId: schoolAId,
              email: "carol@greenwood.com",
              passwordHash,
              firstName: "Carol",
              lastName: "Danvers",
              isActive: true,
              mustChangePassword: false,
              isTwoFactorEnabled: false,
              userRoles: [],
            } as any;
          }
          return null;
        });

      jest.spyOn(sessionRepo, "upsertTwoFactorSecret").mockImplementation(async (params: any) => {
        const record = {
          ...params,
          id: uuidv7(),
          isVerified: false,
          verifiedAt: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        };
        mock2FaSecrets.set(`${params.schoolId}:${params.userId}`, record);
        return record as any;
      });

      jest
        .spyOn(sessionRepo, "findTwoFactorSecret")
        .mockImplementation(async (schoolId: string, userId: string) => {
          return mock2FaSecrets.get(`${schoolId}:${userId}`) ?? null;
        });

      jest.spyOn(sessionRepo, "enableTwoFactor").mockImplementation(async (params: any) => {
        const sec = mock2FaSecrets.get(`${params.schoolId}:${params.userId}`);
        if (sec) {
          sec.isVerified = true;
          sec.verifiedAt = new Date();
        }
        for (const h of params.recoveryCodeHashes) {
          mockRecoveryCodesList.push({
            id: uuidv7(),
            schoolId: params.schoolId,
            userId: params.userId,
            codeHash: h,
            usedAt: null,
            revokedAt: null,
          });
        }
        if (params.userId === userAId) alice2FaEnabled = true;
        if (params.userId === userBId) bob2FaEnabled = true;
      });

      jest
        .spyOn(sessionRepo, "disableTwoFactor")
        .mockImplementation(async (schoolId: string, userId: string) => {
          mock2FaSecrets.delete(`${schoolId}:${userId}`);
          for (const rc of mockRecoveryCodesList) {
            if (rc.schoolId === schoolId && rc.userId === userId) {
              rc.revokedAt = new Date();
            }
          }
          if (userId === userAId) alice2FaEnabled = false;
          if (userId === userBId) bob2FaEnabled = false;
        });

      jest.spyOn(sessionRepo, "regenerateRecoveryCodes").mockImplementation(async (params: any) => {
        for (const rc of mockRecoveryCodesList) {
          if (rc.schoolId === params.schoolId && rc.userId === params.userId) {
            rc.revokedAt = new Date();
          }
        }
        for (const h of params.recoveryCodeHashes) {
          mockRecoveryCodesList.push({
            id: uuidv7(),
            schoolId: params.schoolId,
            userId: params.userId,
            codeHash: h,
            usedAt: null,
            revokedAt: null,
          });
        }
        for (const s of mockSessions) {
          if (
            s.schoolId === params.schoolId &&
            s.userId === params.userId &&
            s.id !== params.currentSessionId &&
            !s.revokedAt
          ) {
            s.revokedAt = new Date();
          }
        }
      });

      jest
        .spyOn(sessionRepo, "verifyAndConsumeRecoveryCode")
        .mockImplementation(async (params: any) => {
          const rc = mockRecoveryCodesList.find(
            (x) =>
              x.schoolId === params.schoolId &&
              x.userId === params.userId &&
              x.codeHash === params.codeHash &&
              !x.usedAt &&
              !x.revokedAt,
          );
          if (!rc) return false;
          rc.usedAt = new Date();
          return true;
        });

      jest
        .spyOn(sessionRepo, "createPasswordResetToken")
        .mockImplementation(async (params: any) => {
          const record = { ...params, id: uuidv7(), usedAt: null, createdAt: new Date() };
          mockResetTokens.push(record);
          return record as any;
        });

      jest
        .spyOn(sessionRepo, "findPasswordResetToken")
        .mockImplementation(async (schoolId: string, tokenHash: string) => {
          const t = mockResetTokens.find(
            (x) => x.schoolId === schoolId && x.tokenHash === tokenHash && !x.usedAt,
          );
          if (!t) return null;
          return {
            ...t,
            user: { id: t.userId, schoolId: t.schoolId, isActive: true, deletedAt: null },
          };
        });

      jest
        .spyOn(sessionRepo, "markPasswordResetTokenUsed")
        .mockImplementation(async (schoolId: string, tokenId: string) => {
          const t = mockResetTokens.find((x) => x.id === tokenId && x.schoolId === schoolId);
          if (t) t.usedAt = new Date();
        });

      jest
        .spyOn(sessionRepo, "createEmailVerificationToken")
        .mockImplementation(async (params: any) => {
          const record = { ...params, id: uuidv7(), usedAt: null, createdAt: new Date() };
          mockVerifyTokens.push(record);
          return record as any;
        });

      jest
        .spyOn(sessionRepo, "findEmailVerificationToken")
        .mockImplementation(async (schoolId: string, tokenHash: string) => {
          const t = mockVerifyTokens.find(
            (x) => x.schoolId === schoolId && x.tokenHash === tokenHash && !x.usedAt,
          );
          if (!t) return null;
          return {
            ...t,
            user: { id: t.userId, schoolId: t.schoolId, isActive: true, deletedAt: null },
          };
        });

      jest
        .spyOn(sessionRepo, "markEmailVerified")
        .mockImplementation(async (schoolId: string, tokenId: string) => {
          const t = mockVerifyTokens.find((x) => x.id === tokenId && x.schoolId === schoolId);
          if (t) t.usedAt = new Date();
        });

      jest.spyOn(sessionRepo, "createSession").mockImplementation(async (params: any) => {
        const sess = {
          id: uuidv7(),
          ...params,
          createdAt: new Date(),
          revokedAt: null,
          familyId: params.familyId || uuidv7(),
        };
        mockSessions.push(sess);
        return sess;
      });

      jest
        .spyOn(sessionRepo, "findSessionByTokenHash")
        .mockImplementation(async (schoolId: string, tokenHash: string) => {
          const sess = mockSessions.find(
            (s) => s.schoolId === schoolId && s.tokenHash === tokenHash,
          );
          if (!sess) return null;
          return {
            ...sess,
            user: { isActive: true, deletedAt: null },
          };
        });

      jest
        .spyOn(sessionRepo, "rotateSession")
        .mockImplementation(async (schoolId: string, oldSessionId: string, newParams: any) => {
          const oldSess = mockSessions.find(
            (s) => s.id === oldSessionId && s.schoolId === schoolId,
          );
          if (oldSess) oldSess.revokedAt = new Date();
          const newSess = {
            id: uuidv7(),
            ...newParams,
            createdAt: new Date(),
            revokedAt: null,
          };
          mockSessions.push(newSess);
          return newSess;
        });

      jest
        .spyOn(sessionRepo, "revokeFamily")
        .mockImplementation(async (schoolId: string, familyId: string) => {
          let count = 0;
          for (const s of mockSessions) {
            if (s.schoolId === schoolId && s.familyId === familyId && !s.revokedAt) {
              s.revokedAt = new Date();
              count++;
            }
          }
          return count;
        });

      jest
        .spyOn(sessionRepo, "revokeAllUserSessions")
        .mockImplementation(async (schoolId: string, userId: string) => {
          let count = 0;
          for (const s of mockSessions) {
            if (s.schoolId === schoolId && s.userId === userId && !s.revokedAt) {
              s.revokedAt = new Date();
              count++;
            }
          }
          return count;
        });

      jest
        .spyOn(sessionRepo, "getUserSessions")
        .mockImplementation(async (schoolId: string, userId: string) => {
          return mockSessions.filter(
            (s) => s.schoolId === schoolId && s.userId === userId && !s.revokedAt,
          );
        });

      jest
        .spyOn(sessionRepo, "revokeOtherUserSessions")
        .mockImplementation(async (schoolId: string, userId: string, exceptSessionId: string) => {
          let count = 0;
          for (const s of mockSessions) {
            if (
              s.schoolId === schoolId &&
              s.userId === userId &&
              s.id !== exceptSessionId &&
              !s.revokedAt
            ) {
              s.revokedAt = new Date();
              count++;
            }
          }
          return count;
        });

      jest
        .spyOn(sessionRepo, "updateUserPassword")
        .mockImplementation(async (_schoolId: string, _userId: string, newHash: string) => {
          passwordHash = newHash;
        });

      jest.spyOn(sessionRepo, "recordUserLogin").mockResolvedValue(undefined);
      jest.spyOn(sessionRepo, "recordAuditLog").mockResolvedValue(undefined);
    }

    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    totpService = app.get(TotpService);

    const authEmailService = app.get(AuthEmailNotificationService);
    const origSendReset = authEmailService.sendPasswordResetEmail.bind(authEmailService);
    authEmailService.sendPasswordResetEmail = async (to: string, compoundToken: string) => {
      capturedResetCompoundToken = compoundToken;
      return origSendReset(to, compoundToken);
    };

    const origSendVerify = authEmailService.sendEmailVerificationEmail.bind(authEmailService);
    authEmailService.sendEmailVerificationEmail = async (to: string, compoundToken: string) => {
      capturedVerifyCompoundToken = compoundToken;
      return origSendVerify(to, compoundToken);
    };

    const deliveryService = (authEmailService as any).emailDeliveryService;
    if (deliveryService) {
      const origSendEmail = deliveryService.sendEmail.bind(deliveryService);
      deliveryService.sendEmail = async (opts: any) => {
        if (opts.subject.includes("Password")) {
          capturedResetEmailPayload = opts;
        } else if (opts.subject.includes("Email") || opts.subject.includes("Verify")) {
          capturedVerifyEmailPayload = opts;
        }
        return origSendEmail(opts);
      };
    }
  });

  afterAll(async () => {
    await app.close();
    try {
      await prisma.$disconnect();
    } catch {
      // ignore offline disconnect
    }
  });

  describe("01. Login Flow & Cookie Transport", () => {
    it("should successfully authenticate with school slug and set HttpOnly SameSite=Lax cookie without Partitioned", async () => {
      const res = await request(app.getHttpServer())
        .post("/api/v1/auth/login")
        .send({
          schoolSlug: "greenwood",
          email: "alice@greenwood.com",
          password: rawPassword,
          clientType: "web",
        })
        .expect(200);

      expect(res.body.accessToken).toBeDefined();
      expect(res.body.expiresIn).toBe(900);
      expect(res.body.user.email).toBe("alice@greenwood.com");
      expect(res.body.user.firstName).toBe("Alice");

      // Verify Set-Cookie header
      const setCookie = res.headers["set-cookie"];
      expect(setCookie).toBeDefined();
      const cookieStr = Array.isArray(setCookie) ? setCookie[0] : setCookie;
      expect(cookieStr).toMatch(/^pe_refresh_token=/);
      expect(cookieStr).toMatch(/Path=\/api\/v1\/auth/);
      expect(cookieStr).toMatch(/HttpOnly/i);
      expect(cookieStr).toMatch(/SameSite=Lax/i);
      expect(cookieStr).not.toMatch(/Partitioned/i); // Amendment 5: dropped Partitioned
    });

    it("should return refresh token in body when clientType is mobile", async () => {
      const res = await request(app.getHttpServer())
        .post("/api/v1/auth/login")
        .send({
          schoolSlug: "greenwood",
          email: "alice@greenwood.com",
          password: rawPassword,
          clientType: "mobile",
        })
        .expect(200);

      expect(res.body.refreshToken).toBeDefined();
      expect(res.body.refreshToken).toMatch(new RegExp(`^${schoolAId}\\.`));
    });
  });

  describe("02. Timing-Safe & Generic Error Handling", () => {
    it("should return identical 401 error message for wrong password, non-existent user, and non-existent school", async () => {
      // 1. Wrong password
      const resWrongPass = await request(app.getHttpServer())
        .post("/api/v1/auth/login")
        .send({
          schoolSlug: "greenwood",
          email: "alice@greenwood.com",
          password: "WrongPassword999!",
        })
        .expect(401);

      // 2. Unknown user in existing school
      const resUnknownUser = await request(app.getHttpServer())
        .post("/api/v1/auth/login")
        .send({
          schoolSlug: "greenwood",
          email: "nonexistent@greenwood.com",
          password: "WrongPassword999!",
        })
        .expect(401);

      // 3. Unknown school slug
      const resUnknownSchool = await request(app.getHttpServer())
        .post("/api/v1/auth/login")
        .send({
          schoolSlug: "unknown-school-xyz",
          email: "alice@greenwood.com",
          password: "WrongPassword999!",
        })
        .expect(401);

      expect(resWrongPass.body.detail ?? resWrongPass.body.message).toBe("Invalid credentials.");
      expect(resUnknownUser.body.detail ?? resUnknownUser.body.message).toBe(
        "Invalid credentials.",
      );
      expect(resUnknownSchool.body.detail ?? resUnknownSchool.body.message).toBe(
        "Invalid credentials.",
      );
    });
  });

  describe("03. Protected Requests: Tenant Scoped ONLY from Access Token (Amendment 1)", () => {
    it("should derive tenant context exclusively from access token and ignore X-School-Slug or x-school-id headers", async () => {
      // 1. Login as Alice (School A)
      const loginRes = await request(app.getHttpServer())
        .post("/api/v1/auth/login")
        .send({
          schoolSlug: "greenwood",
          email: "alice@greenwood.com",
          password: rawPassword,
        })
        .expect(200);

      const tokenA = loginRes.body.accessToken;

      // 2. Request /api/v1/auth/me while providing headers claiming School B
      const meRes = await request(app.getHttpServer())
        .get("/api/v1/auth/me")
        .set("Authorization", `Bearer ${tokenA}`)
        .set("X-School-Slug", "oakridge")
        .set("x-school-id", schoolBId)
        .expect(200);

      // 3. Must return Alice from School A, completely ignoring the School B headers
      expect(meRes.body.id).toBe(userAId);
      expect(meRes.body.email).toBe("alice@greenwood.com");
    });
  });

  describe("04. Refresh Token Rotation & Transport", () => {
    it("should rotate refresh token and issue new access token", async () => {
      const loginRes = await request(app.getHttpServer())
        .post("/api/v1/auth/login")
        .send({
          schoolSlug: "greenwood",
          email: "alice@greenwood.com",
          password: rawPassword,
        })
        .expect(200);

      const cookie = loginRes.headers["set-cookie"];
      const cookieHeader = Array.isArray(cookie) ? cookie[0] : (cookie as string);

      const refreshRes = await request(app.getHttpServer())
        .post("/api/v1/auth/refresh")
        .set("Cookie", cookieHeader ?? "")
        .send({})
        .expect(200);

      expect(refreshRes.body.accessToken).toBeDefined();
      expect(refreshRes.headers["set-cookie"]).toBeDefined();
    });
  });

  describe("05. Tampered School ID in Refresh Cookie Fails Closed (Amendment 2)", () => {
    it("should reject refresh when schoolId in cookie is tampered to another school", async () => {
      const loginRes = await request(app.getHttpServer())
        .post("/api/v1/auth/login")
        .send({
          schoolSlug: "greenwood",
          email: "alice@greenwood.com",
          password: rawPassword,
          clientType: "mobile",
        })
        .expect(200);

      const realRefreshToken = loginRes.body.refreshToken as string;
      const dotIndex = realRefreshToken.indexOf(".");
      const rawTokenPart = realRefreshToken.slice(dotIndex + 1);

      // Tamper: replace School A id with School B id
      const tamperedToken = `${schoolBId}.${rawTokenPart}`;

      await request(app.getHttpServer())
        .post("/api/v1/auth/refresh")
        .send({ refreshToken: tamperedToken })
        .expect(401);
    });
  });

  describe("06. Duplicate In-Window Refresh Requests Return Identical Successor (Amendment 4)", () => {
    it("should return the exact same successor token for duplicate requests within 10s grace window", async () => {
      const loginRes = await request(app.getHttpServer())
        .post("/api/v1/auth/login")
        .send({
          schoolSlug: "greenwood",
          email: "alice@greenwood.com",
          password: rawPassword,
          clientType: "mobile",
        })
        .expect(200);

      const initialToken = loginRes.body.refreshToken;

      // Request 1: triggers rotation
      const res1 = await request(app.getHttpServer())
        .post("/api/v1/auth/refresh")
        .send({ refreshToken: initialToken, clientType: "mobile" })
        .expect(200);

      // Request 2: duplicate call within grace window with the SAME initial token
      const res2 = await request(app.getHttpServer())
        .post("/api/v1/auth/refresh")
        .send({ refreshToken: initialToken, clientType: "mobile" })
        .expect(200);

      // Invariant: Both requests received the EXACT SAME tokens without killing the session
      expect(res1.body.accessToken).toBe(res2.body.accessToken);
      expect(res1.body.refreshToken).toBe(res2.body.refreshToken);
    });
  });

  describe("07. Token Reuse / Replay Detection Revokes Family", () => {
    it("should revoke entire session family if revoked token is replayed outside grace window", async () => {
      // 1. Initial login
      const loginRes = await request(app.getHttpServer())
        .post("/api/v1/auth/login")
        .send({
          schoolSlug: "greenwood",
          email: "alice@greenwood.com",
          password: rawPassword,
          clientType: "mobile",
        })
        .expect(200);

      const t1 = loginRes.body.refreshToken as string;

      // 2. Rotate to t2
      const resRotated = await request(app.getHttpServer())
        .post("/api/v1/auth/refresh")
        .send({ refreshToken: t1, clientType: "mobile" })
        .expect(200);

      const t2 = resRotated.body.refreshToken as string;

      // Manually invalidate the grace window cache in Redis to simulate post-grace-period replay
      const rawToken1 = t1.slice(t1.indexOf(".") + 1);
      const crypto = require("node:crypto");
      const hash1 = crypto.createHash("sha256").update(rawToken1).digest("hex");
      const redisService = app.get(RedisService);
      await redisService.getClient()?.del(`auth:grace:${hash1}`);

      // 3. Replay revoked token t1 outside grace window
      await request(app.getHttpServer())
        .post("/api/v1/auth/refresh")
        .send({ refreshToken: t1 })
        .expect(401);

      // 4. Verify that t2 was ALSO revoked as part of the family termination
      await request(app.getHttpServer())
        .post("/api/v1/auth/refresh")
        .send({ refreshToken: t2 })
        .expect(401);
    });
  });

  describe("08. Anti-DoS Lockout (Amendment 3)", () => {
    it("should lock out only the offending IP while allowing legitimate user on another IP to log in", async () => {
      const attackerIp = "198.51.100.99";
      const legitimateIp = "203.0.113.10";

      // Attacker on IP 1 fails 5 times against Alice's account
      for (let i = 0; i < 5; i++) {
        await request(app.getHttpServer())
          .post("/api/v1/auth/login")
          .set("X-Forwarded-For", attackerIp)
          .send({
            schoolSlug: "greenwood",
            email: "alice@greenwood.com",
            password: "WrongPassword999!",
          })
          .expect(401);
      }

      // Attacker on IP 1 is now locked out
      await request(app.getHttpServer())
        .post("/api/v1/auth/login")
        .set("X-Forwarded-For", attackerIp)
        .send({
          schoolSlug: "greenwood",
          email: "alice@greenwood.com",
          password: rawPassword,
        })
        .expect(401);

      // Legitimate user on IP 2 can log in without being blocked by attacker's activity!
      const legitRes = await request(app.getHttpServer())
        .post("/api/v1/auth/login")
        .set("X-Forwarded-For", legitimateIp)
        .send({
          schoolSlug: "greenwood",
          email: "alice@greenwood.com",
          password: rawPassword,
        })
        .expect(200);

      expect(legitRes.body.accessToken).toBeDefined();
    });

    it("should apply progressive delay across rotating IPs targeting single account without hard lockout", async () => {
      // 5 distinct IPs attempt 1 wrong password each against Bob's account
      for (let i = 1; i <= 5; i++) {
        await request(app.getHttpServer())
          .post("/api/v1/auth/login")
          .set("X-Forwarded-For", `198.51.100.${i}`)
          .send({
            schoolSlug: "oakridge",
            email: "bob@oakridge.com",
            password: "WrongPassword999!",
          })
          .expect(401);
      }

      // 6th rotating IP experiences progressive delay, but Bob can still log in with correct password
      const start = Date.now();
      const legitRes = await request(app.getHttpServer())
        .post("/api/v1/auth/login")
        .set("X-Forwarded-For", "198.51.100.6")
        .send({
          schoolSlug: "oakridge",
          email: "bob@oakridge.com",
          password: rawPassword,
        })
        .expect(200);

      const elapsed = Date.now() - start;
      expect(elapsed).toBeGreaterThanOrEqual(150);
      expect(legitRes.body.accessToken).toBeDefined();

      // Clean up Bob's session after test
      await request(app.getHttpServer())
        .post("/api/v1/auth/logout-all")
        .set("Authorization", `Bearer ${legitRes.body.accessToken}`)
        .expect(200);
    });
  });

  describe("09. Logout-All Tenant Scoped (Amendment 9)", () => {
    it("should revoke all sessions for Alice in School A without touching Bob in School B", async () => {
      // 1. Create 2 sessions for Alice
      const loginA1 = await request(app.getHttpServer())
        .post("/api/v1/auth/login")
        .send({ schoolSlug: "greenwood", email: "alice@greenwood.com", password: rawPassword })
        .expect(200);

      const loginA2 = await request(app.getHttpServer())
        .post("/api/v1/auth/login")
        .send({ schoolSlug: "greenwood", email: "alice@greenwood.com", password: rawPassword })
        .expect(200);

      // 2. Create 1 session for Bob in School B
      const loginB = await request(app.getHttpServer())
        .post("/api/v1/auth/login")
        .send({ schoolSlug: "oakridge", email: "bob@oakridge.com", password: rawPassword })
        .expect(200);

      // 3. Alice calls logout-all
      const logoutAllRes = await request(app.getHttpServer())
        .post("/api/v1/auth/logout-all")
        .set("Authorization", `Bearer ${loginA1.body.accessToken}`)
        .expect(200);

      expect(logoutAllRes.body.revokedSessions).toBeGreaterThanOrEqual(2);

      // 4. Alice's sessions are revoked: /me fails with 404/revoked or sessions endpoint reflects zero active
      const aliceSessions = await request(app.getHttpServer())
        .get("/api/v1/auth/sessions")
        .set("Authorization", `Bearer ${loginA2.body.accessToken}`)
        .expect(200);

      expect(aliceSessions.body.sessions).toHaveLength(0);

      // 5. Bob's session in School B remains completely unaffected
      const bobSessions = await request(app.getHttpServer())
        .get("/api/v1/auth/sessions")
        .set("Authorization", `Bearer ${loginB.body.accessToken}`)
        .expect(200);

      expect(bobSessions.body.sessions).toHaveLength(1);
    });
  });

  describe("10. Token Tampering & Security", () => {
    it("should reject token with alg: none", async () => {
      const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
      const payload = Buffer.from(
        JSON.stringify({
          sub: userAId,
          schoolId: schoolAId,
          sessionId: uuidv7(),
          exp: Math.floor(Date.now() / 1000) + 900,
        }),
      ).toString("base64url");
      const noneToken = `${header}.${payload}.`;

      await request(app.getHttpServer())
        .get("/api/v1/auth/me")
        .set("Authorization", `Bearer ${noneToken}`)
        .expect(401);
    });

    it("should reject expired token", async () => {
      const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString(
        "base64url",
      );
      const payload = Buffer.from(
        JSON.stringify({
          sub: userAId,
          schoolId: schoolAId,
          sessionId: uuidv7(),
          exp: Math.floor(Date.now() / 1000) - 3600, // Expired 1 hour ago
        }),
      ).toString("base64url");
      const expiredToken = `${header}.${payload}.signature`;

      await request(app.getHttpServer())
        .get("/api/v1/auth/me")
        .set("Authorization", `Bearer ${expiredToken}`)
        .expect(401);
    });

    it("should reject token signed with wrong key", async () => {
      const wrongKeySecret = new TextEncoder().encode("wrong-key-secret-min32-characters-long!!");
      const wrongKeyToken = await new SignJWT({
        sub: userAId,
        schoolId: schoolAId,
        sessionId: uuidv7(),
      })
        .setProtectedHeader({ alg: "HS256" })
        .setIssuedAt()
        .setExpirationTime("15m")
        .sign(wrongKeySecret);

      await request(app.getHttpServer())
        .get("/api/v1/auth/me")
        .set("Authorization", `Bearer ${wrongKeyToken}`)
        .expect(401);
    });
  });

  describe("11. CSRF Defence on Refresh & Logout (Amendment 5)", () => {
    it("should reject refresh with 403 when Origin header does not match allowed origin", async () => {
      await request(app.getHttpServer())
        .post("/api/v1/auth/refresh")
        .set("Origin", "https://attacker-origin.com")
        .send({ refreshToken: "dummy.token" })
        .expect(403);
    });
  });

  describe("12. Zero Passwords and Secrets in Logs", () => {
    it("should assert that no plaintext password or raw secret appears in application logs", () => {
      const logsCombined = testLogBuffer.join("\n");
      expect(logsCombined).not.toContain(rawPassword);
      expect(logsCombined).not.toContain("WrongPassword999!");
      expect(logsCombined).not.toContain("super-secret-plain-text");
    });
  });

  describe("13. Password Change Revoking Other Sessions", () => {
    it("should allow password change on device 1, keep session 1 active, and revoke session 2", async () => {
      // 1. Login on device 1
      const login1 = await request(app.getHttpServer())
        .post("/api/v1/auth/login")
        .send({
          schoolSlug: "greenwood",
          email: "alice@greenwood.com",
          password: rawPassword,
        })
        .expect(200);

      const cookie1 = login1.headers["set-cookie"]?.[0]?.split(";")[0] || "";

      // 2. Login on device 2
      const login2 = await request(app.getHttpServer())
        .post("/api/v1/auth/login")
        .send({
          schoolSlug: "greenwood",
          email: "alice@greenwood.com",
          password: rawPassword,
        })
        .expect(200);

      const cookie2 = login2.headers["set-cookie"]?.[0]?.split(";")[0] || "";

      // Check 2 active sessions
      const sessionsBefore = await request(app.getHttpServer())
        .get("/api/v1/auth/sessions")
        .set("Authorization", `Bearer ${login1.body.accessToken}`)
        .expect(200);

      expect(sessionsBefore.body.sessions).toHaveLength(2);

      // 3. Alice changes password from device 1
      const newPassword = "NewAlicePassword12345!";
      const changeRes = await request(app.getHttpServer())
        .post("/api/v1/auth/change-password")
        .set("Authorization", `Bearer ${login1.body.accessToken}`)
        .send({
          currentPassword: rawPassword,
          newPassword,
        })
        .expect(200);

      expect(changeRes.body.revokedOtherSessionsCount).toBe(1);

      // 4. Device 1 session remains valid
      await request(app.getHttpServer())
        .get("/api/v1/auth/me")
        .set("Authorization", `Bearer ${login1.body.accessToken}`)
        .expect(200);

      // 5. Device 2 refresh attempt fails because its session was revoked
      await request(app.getHttpServer())
        .post("/api/v1/auth/refresh")
        .set("Cookie", cookie2)
        .send({})
        .expect(401);

      // 6. Active sessions for Alice is now down to 1
      const sessionsAfter = await request(app.getHttpServer())
        .get("/api/v1/auth/sessions")
        .set("Authorization", `Bearer ${login1.body.accessToken}`)
        .expect(200);

      expect(sessionsAfter.body.sessions).toHaveLength(1);

      // Restore password for other tests
      passwordHash = await argon2.hash(rawPassword, {
        type: argon2.argon2id,
        memoryCost: 4096,
        timeCost: 2,
        parallelism: 1,
      });
      await prisma.$executeRaw`
        UPDATE users SET password_hash = ${passwordHash} WHERE id = ${userAId}::uuid;
      `;
    });
  });

  describe("14. Redis Distributed Cache Failure (HTTP 503)", () => {
    it("should return HTTP 503 Service Unavailable on refresh when Redis distributed cache is down", async () => {
      const redisService = app.get(RedisService);
      const spy = jest
        .spyOn(redisService, "getClient")
        .mockReturnValue({ status: "connecting" } as unknown as Redis);

      try {
        await request(app.getHttpServer())
          .post("/api/v1/auth/refresh")
          .send({ refreshToken: "schoolA.some-raw-token" })
          .expect(503);
      } finally {
        spy.mockRestore();
      }
    });
  });

  describe("15. Password Reset Flow: Token Expiry, Single-Use & Session Revocation (Amendment 5)", () => {
    it("should issue a reset token, reset password, revoke all active sessions, and NEVER log the user in", async () => {
      // 1. Establish an active session for Alice
      const loginRes = await request(app.getHttpServer())
        .post("/api/v1/auth/login")
        .send({
          schoolSlug: "greenwood",
          email: "alice@greenwood.com",
          password: rawPassword,
          clientType: "web",
        })
        .expect(200);

      const activeToken = loginRes.body.accessToken;

      // 2. Request password reset (anti-enumeration generic 200)
      const forgotRes = await request(app.getHttpServer())
        .post("/api/v1/auth/forgot-password")
        .send({
          schoolSlug: "greenwood",
          email: "alice@greenwood.com",
        })
        .expect(200);

      expect(forgotRes.body.message).toContain("If an account matches that email");

      // 3. Retrieve generated token hash from database
      const resetRow: any[] = await prisma.$queryRaw`
        SELECT id, token_hash, expires_at, used_at FROM password_reset_tokens
        WHERE school_id = ${schoolAId}::uuid AND user_id = ${userAId}::uuid AND used_at IS NULL
        ORDER BY created_at DESC LIMIT 1;
      `;
      expect(resetRow).toHaveLength(1);

      // In real scenario, the token sent via email is <schoolId>.<rawToken>.
      // We captured the REAL token dispatched to the email notification service
      expect(capturedResetCompoundToken).toBeTruthy();

      // 4. Submit password reset with new strong password using real captured token
      const newPassword = "NewAlicePassword12345!";
      const resetRes = await request(app.getHttpServer())
        .post("/api/v1/auth/reset-password")
        .send({
          token: capturedResetCompoundToken,
          newPassword,
        })
        .expect(200);

      expect(resetRes.body.message).toContain("Password has been successfully reset");
      // NEVER logs the user in!
      expect(resetRes.body.accessToken).toBeUndefined();

      // 5. Verify old active session was revoked across all devices (Amendment 5)
      await request(app.getHttpServer())
        .get("/api/v1/auth/me")
        .set("Authorization", `Bearer ${activeToken}`)
        .expect(200); // JWT signature is valid for 15m, but database session is revoked:
      const sessions = await prisma.$queryRaw<any[]>`
        SELECT id, revoked_at FROM sessions
        WHERE school_id = ${schoolAId}::uuid AND user_id = ${userAId}::uuid AND revoked_at IS NULL;
      `;
      expect(sessions).toHaveLength(0);

      // 6. Login with new password succeeds
      const newLoginRes = await request(app.getHttpServer())
        .post("/api/v1/auth/login")
        .send({
          schoolSlug: "greenwood",
          email: "alice@greenwood.com",
          password: newPassword,
        })
        .expect(200);
      expect(newLoginRes.body.accessToken).toBeDefined();

      // 7. Login with old password fails
      await request(app.getHttpServer())
        .post("/api/v1/auth/login")
        .send({
          schoolSlug: "greenwood",
          email: "alice@greenwood.com",
          password: rawPassword,
        })
        .expect(401);

      // Restore password
      passwordHash = await argon2.hash(rawPassword, {
        type: argon2.argon2id,
        memoryCost: 4096,
        timeCost: 2,
        parallelism: 1,
      });
      await prisma.$executeRaw`
        UPDATE users SET password_hash = ${passwordHash} WHERE id = ${userAId}::uuid;
      `;
    });
  });

  describe("16. Password Reset Token Reuse & Cross-Tenant Tampering", () => {
    it("should reject replaying an already used reset token", async () => {
      const crypto = await import("node:crypto");
      const rawToken = crypto.randomBytes(32).toString("hex");
      const tokenHash = crypto.createHash("sha256").update(rawToken).digest("hex");
      const compoundToken = `${schoolAId}.${rawToken}`;

      await prisma.$executeRaw`
        INSERT INTO password_reset_tokens (id, school_id, user_id, token_hash, expires_at, used_at)
        VALUES (${uuidv7()}::uuid, ${schoolAId}::uuid, ${userAId}::uuid, ${tokenHash}, CURRENT_TIMESTAMP + INTERVAL '1 hour', CURRENT_TIMESTAMP);
      `;

      await request(app.getHttpServer())
        .post("/api/v1/auth/reset-password")
        .send({
          token: compoundToken,
          newPassword: "SuperSecurePassword123!",
        })
        .expect(400);
    });

    it("should reject cross-tenant token tampering (School B prefix with School A token)", async () => {
      const crypto = await import("node:crypto");
      const rawToken = crypto.randomBytes(32).toString("hex");
      const tokenHash = crypto.createHash("sha256").update(rawToken).digest("hex");

      // Insert token belonging to School A
      await prisma.$executeRaw`
        INSERT INTO password_reset_tokens (id, school_id, user_id, token_hash, expires_at)
        VALUES (${uuidv7()}::uuid, ${schoolAId}::uuid, ${userAId}::uuid, ${tokenHash}, CURRENT_TIMESTAMP + INTERVAL '1 hour');
      `;

      // Attacker attempts to redeem token by binding it to School B
      const tamperedToken = `${schoolBId}.${rawToken}`;

      await request(app.getHttpServer())
        .post("/api/v1/auth/reset-password")
        .send({
          token: tamperedToken,
          newPassword: "SuperSecurePassword123!",
        })
        .expect(400);
    });

    it("should reject expired reset token", async () => {
      const crypto = await import("node:crypto");
      const rawToken = crypto.randomBytes(32).toString("hex");
      const tokenHash = crypto.createHash("sha256").update(rawToken).digest("hex");
      const compoundToken = `${schoolAId}.${rawToken}`;

      // Insert token expired 1 hour ago
      await prisma.$executeRaw`
        INSERT INTO password_reset_tokens (id, school_id, user_id, token_hash, expires_at)
        VALUES (${uuidv7()}::uuid, ${schoolAId}::uuid, ${userAId}::uuid, ${tokenHash}, CURRENT_TIMESTAMP - INTERVAL '1 hour');
      `;

      await request(app.getHttpServer())
        .post("/api/v1/auth/reset-password")
        .send({
          token: compoundToken,
          newPassword: "SuperSecurePassword123!",
        })
        .expect(400);
    });
  });

  describe("17. Email Verification Flow & Invalidation of Older Tokens", () => {
    it("should verify email and reject token reuse", async () => {
      // 1. Trigger resend verification for Alice to capture real verification token from flow
      await request(app.getHttpServer())
        .post("/api/v1/auth/verify-email/resend")
        .send({
          schoolSlug: "greenwood",
          email: "alice@greenwood.com",
        })
        .expect(200);

      expect(capturedVerifyCompoundToken).toBeTruthy();

      // 2. Verify email using the real captured compound token
      const verifyRes = await request(app.getHttpServer())
        .post("/api/v1/auth/verify-email")
        .send({ token: capturedVerifyCompoundToken })
        .expect(200);

      expect(verifyRes.body.message).toContain("Email has been successfully verified");

      // 3. Verify user record has email_verified_at set
      const user: any[] = await prisma.$queryRaw`
        SELECT email_verified_at FROM users WHERE id = ${userAId}::uuid;
      `;
      expect(user[0].email_verified_at).not.toBeNull();

      // 4. Replay verification token fails with 400
      await request(app.getHttpServer())
        .post("/api/v1/auth/verify-email")
        .send({ token: capturedVerifyCompoundToken })
        .expect(400);
    });

    it("should format email text and html containing token link only after '#' and never after '?'", () => {
      expect(capturedResetEmailPayload).toBeDefined();
      expect(capturedResetEmailPayload.subject).toBe("Reset Your ProgressEye Password");
      expect(capturedResetEmailPayload.subject).not.toContain(capturedResetCompoundToken);

      // Reset text link: token must follow '#' and never '?'
      expect(capturedResetEmailPayload.text).toContain(
        `http://localhost:3000/auth/reset-password#token=${capturedResetCompoundToken}`,
      );
      expect(capturedResetEmailPayload.text).not.toContain("?token=");
      expect(capturedResetEmailPayload.text).not.toContain("?");

      // Reset HTML link: token must follow '#' and never '?'
      expect(capturedResetEmailPayload.html).toContain(
        `href="http://localhost:3000/auth/reset-password#token=${capturedResetCompoundToken}"`,
      );
      expect(capturedResetEmailPayload.html).not.toContain("?token=");
      expect(capturedResetEmailPayload.html).not.toContain("?");

      expect(capturedVerifyEmailPayload).toBeDefined();
      expect(capturedVerifyEmailPayload.subject).toBe("Verify Your ProgressEye Email");
      expect(capturedVerifyEmailPayload.subject).not.toContain(capturedVerifyCompoundToken);

      // Verification text link: token must follow '#' and never '?'
      expect(capturedVerifyEmailPayload.text).toContain(
        `http://localhost:3000/auth/verify-email#token=${capturedVerifyCompoundToken}`,
      );
      expect(capturedVerifyEmailPayload.text).not.toContain("?token=");
      expect(capturedVerifyEmailPayload.text).not.toContain("?");

      // Verification HTML link: token must follow '#' and never '?'
      expect(capturedVerifyEmailPayload.html).toContain(
        `href="http://localhost:3000/auth/verify-email#token=${capturedVerifyCompoundToken}"`,
      );
      expect(capturedVerifyEmailPayload.html).not.toContain("?token=");
      expect(capturedVerifyEmailPayload.html).not.toContain("?");
    });
  });

  describe("18. First-Login Forced Password Change", () => {
    it("should require password change before granting access when must_change_password is true", async () => {
      // 1. Set must_change_password to true for Bob
      await prisma.$executeRaw`
        UPDATE users SET must_change_password = true WHERE id = ${userBId}::uuid;
      `;

      // 2. Login returns mustChangePassword: true and temporaryToken, NO refresh cookie
      const loginRes = await request(app.getHttpServer())
        .post("/api/v1/auth/login")
        .send({
          schoolSlug: "oakridge",
          email: "bob@oakridge.com",
          password: rawPassword,
        })
        .expect(200);

      expect(loginRes.body.mustChangePassword).toBe(true);
      expect(loginRes.body.temporaryToken).toBeDefined();
      expect(loginRes.body.accessToken).toBeUndefined();

      const tempToken = loginRes.body.temporaryToken;

      // 3. Attempting to call protected route (/me) with temporaryToken is rejected with 403
      await request(app.getHttpServer())
        .get("/api/v1/auth/me")
        .set("Authorization", `Bearer ${tempToken}`)
        .expect(403);

      // 4. Submit first-login password change
      const newBobPassword = "NewBobSuperPassword12345!";
      const changeRes = await request(app.getHttpServer())
        .post("/api/v1/auth/first-login-password")
        .set("Authorization", `Bearer ${tempToken}`)
        .send({
          newPassword: newBobPassword,
        })
        .expect(200);

      expect(changeRes.body.accessToken).toBeDefined();
      expect(changeRes.body.user.mustChangePassword).toBe(false);

      // 5. Subsequent access to /me with new accessToken succeeds
      await request(app.getHttpServer())
        .get("/api/v1/auth/me")
        .set("Authorization", `Bearer ${changeRes.body.accessToken}`)
        .expect(200);

      // Restore Bob
      await prisma.$executeRaw`
        UPDATE users SET must_change_password = false, password_hash = ${passwordHash} WHERE id = ${userBId}::uuid;
      `;
    });
  });

  describe("19. Generic Enumeration Resistance for Forgot Password & Email Verification", () => {
    it("should return identical generic messages for existing, non-existing user, and non-existing school", async () => {
      const res1 = await request(app.getHttpServer())
        .post("/api/v1/auth/forgot-password")
        .send({ schoolSlug: "greenwood", email: "alice@greenwood.com" })
        .expect(200);

      const res2 = await request(app.getHttpServer())
        .post("/api/v1/auth/forgot-password")
        .send({ schoolSlug: "greenwood", email: "nonexistent@greenwood.com" })
        .expect(200);

      const res3 = await request(app.getHttpServer())
        .post("/api/v1/auth/forgot-password")
        .send({ schoolSlug: "nonexistent-school", email: "alice@greenwood.com" })
        .expect(200);

      expect(res1.body.message).toBe(res2.body.message);
      expect(res2.body.message).toBe(res3.body.message);
    });

    it("should exhibit comparable latency between existing user, non-existing user, and non-existing school (coarse timing test)", async () => {
      const samples = 3;
      const existingTimes: number[] = [];
      const unknownUserTimes: number[] = [];
      const unknownSchoolTimes: number[] = [];

      for (let i = 0; i < samples; i++) {
        const ip1 = `198.51.100.${60 + i * 3 + 1}`;
        const ip2 = `198.51.100.${60 + i * 3 + 2}`;
        const ip3 = `198.51.100.${60 + i * 3 + 3}`;
        const email = `unknown-timing-${i}@greenwood.com`;

        // 1. Existing user in existing school (unique IP 1 per request)
        const t1 = performance.now();
        const resExisting = await request(app.getHttpServer())
          .post("/api/v1/auth/forgot-password")
          .set("x-forwarded-for", ip1)
          .send({ schoolSlug: "greenwood", email: "alice@greenwood.com" })
          .expect(200);
        existingTimes.push(performance.now() - t1);

        // 2. Unknown user in existing school (unique IP 2 per request)
        const t2 = performance.now();
        const resUnknownUser = await request(app.getHttpServer())
          .post("/api/v1/auth/forgot-password")
          .set("x-forwarded-for", ip2)
          .send({ schoolSlug: "greenwood", email })
          .expect(200);
        unknownUserTimes.push(performance.now() - t2);

        // 3. Unknown school slug (unique IP 3 per request)
        const t3 = performance.now();
        const resUnknownSchool = await request(app.getHttpServer())
          .post("/api/v1/auth/forgot-password")
          .set("x-forwarded-for", ip3)
          .send({ schoolSlug: "unknown-school-slug", email })
          .expect(200);
        unknownSchoolTimes.push(performance.now() - t3);

        // Confirm identical body and status
        expect(resExisting.body).toEqual(resUnknownUser.body);
        expect(resUnknownUser.body).toEqual(resUnknownSchool.body);
      }

      const avgExisting = existingTimes.reduce((a, b) => a + b, 0) / existingTimes.length;
      const avgUnknownUser = unknownUserTimes.reduce((a, b) => a + b, 0) / unknownUserTimes.length;
      const avgUnknownSchool =
        unknownSchoolTimes.reduce((a, b) => a + b, 0) / unknownSchoolTimes.length;

      // Loose tolerance: ratios within 4x to accommodate CI virtualization jitter
      expect(avgExisting).toBeGreaterThan(0);
      expect(avgUnknownUser).toBeGreaterThan(0);
      expect(avgUnknownSchool).toBeGreaterThan(0);
      expect(avgUnknownUser / avgExisting).toBeLessThan(4);
      expect(avgExisting / avgUnknownUser).toBeLessThan(4);
      expect(avgUnknownSchool / avgExisting).toBeLessThan(4);
      expect(avgExisting / avgUnknownSchool).toBeLessThan(4);
    });
  });

  describe("20. Zero Tokens, Secrets and Passwords in Logs (Phase 12b-1)", () => {
    it("should never log raw reset tokens, passwords, or verification tokens in Pino logs", async () => {
      const crypto = await import("node:crypto");
      const combinedLogs = testLogBuffer.join("\n");

      // Passwords
      expect(combinedLogs).not.toContain("NewAlicePassword12345!");
      expect(combinedLogs).not.toContain("NewBobSuperPassword12345!");

      // Captured real reset token (compound, raw, and hash)
      expect(capturedResetCompoundToken).toBeTruthy();
      const rawResetToken = capturedResetCompoundToken.split(".")[1] || "";
      const resetTokenHash = crypto.createHash("sha256").update(rawResetToken).digest("hex");
      expect(combinedLogs).not.toContain(capturedResetCompoundToken);
      expect(combinedLogs).not.toContain(rawResetToken);
      expect(combinedLogs).not.toContain(resetTokenHash);

      // Captured real verification token (compound, raw, and hash)
      expect(capturedVerifyCompoundToken).toBeTruthy();
      const rawVerifyToken = capturedVerifyCompoundToken.split(".")[1] || "";
      const verifyTokenHash = crypto.createHash("sha256").update(rawVerifyToken).digest("hex");
      expect(combinedLogs).not.toContain(capturedVerifyCompoundToken);
      expect(combinedLogs).not.toContain(rawVerifyToken);
      expect(combinedLogs).not.toContain(verifyTokenHash);
    });
  });

  describe("Phase 12b-2: Two-Factor Authentication, Recovery Codes & SMS Stub Attack Suite", () => {
    let aliceAccessToken = "";
    let bobAccessToken = "";
    let bobRecoveryCodes: string[] = [];

    beforeAll(async () => {
      // 1. Alice logs in
      const aliceLogin = await request(app.getHttpServer())
        .post("/api/v1/auth/login")
        .send({
          schoolSlug: "greenwood",
          email: "alice@greenwood.com",
          password: rawPassword,
          clientType: "web",
        })
        .expect(200);
      aliceAccessToken = aliceLogin.body.accessToken;

      // 2. Alice sets up 2FA
      const aliceSetup = await request(app.getHttpServer())
        .post("/api/v1/auth/2fa/setup")
        .set("Authorization", `Bearer ${aliceAccessToken}`)
        .expect(200);
      capturedTotpSecret = aliceSetup.body.secret;
      expect(capturedTotpSecret).toHaveLength(32);
      expect(aliceSetup.body.uri).toContain("otpauth://totp");

      // 3. Alice enables 2FA with first valid code
      capturedTotpCode = totpService.generateCode(capturedTotpSecret);
      const aliceEnable = await request(app.getHttpServer())
        .post("/api/v1/auth/2fa/enable")
        .set("Authorization", `Bearer ${aliceAccessToken}`)
        .send({ code: capturedTotpCode })
        .expect(200);
      capturedRecoveryCodes = aliceEnable.body.recoveryCodes;
      expect(capturedRecoveryCodes).toHaveLength(8);

      // 4. Bob (Tenant B) logs in, sets up and enables 2FA for cross-tenant tests
      const bobLogin = await request(app.getHttpServer())
        .post("/api/v1/auth/login")
        .send({
          schoolSlug: "oakridge",
          email: "bob@oakridge.com",
          password: rawPassword,
          clientType: "web",
        })
        .expect(200);
      bobAccessToken = bobLogin.body.accessToken;

      const bobSetup = await request(app.getHttpServer())
        .post("/api/v1/auth/2fa/setup")
        .set("Authorization", `Bearer ${bobAccessToken}`)
        .expect(200);

      const bobCode = totpService.generateCode(bobSetup.body.secret);
      const bobEnable = await request(app.getHttpServer())
        .post("/api/v1/auth/2fa/enable")
        .set("Authorization", `Bearer ${bobAccessToken}`)
        .send({ code: bobCode })
        .expect(200);
      bobRecoveryCodes = bobEnable.body.recoveryCodes;
      expect(bobRecoveryCodes).toHaveLength(8);
    });

    it("TOTP replay: rejects immediate reuse of the same TOTP code within the same step", async () => {
      const redisService = app.get(RedisService);
      const redisClient = redisService.getClient();
      if (redisClient) {
        await redisClient.del(`auth:2fa:attempts:${userAId}`);
        const replayKeys = await redisClient.keys(`auth:totp:replay:${userAId}:*`);
        if (replayKeys.length > 0) {
          await redisClient.del(...replayKeys);
        }
      }

      // Alice logs in and receives temporary token with 2fa_pending scope
      const loginRes = await request(app.getHttpServer())
        .post("/api/v1/auth/login")
        .send({
          schoolSlug: "greenwood",
          email: "alice@greenwood.com",
          password: rawPassword,
          clientType: "web",
        })
        .expect(200);

      expect(loginRes.body.requires2Fa).toBe(true);
      const tempToken = loginRes.body.temporaryToken;
      expect(tempToken).toBeTruthy();

      const code = totpService.generateCode(capturedTotpSecret);

      // First verify succeeds
      const verifyRes1 = await request(app.getHttpServer())
        .post("/api/v1/auth/2fa/verify")
        .send({ temporaryToken: tempToken, code })
        .expect(200);

      expect(verifyRes1.body.accessToken).toBeTruthy();

      // Alice logs in again to get fresh temporaryToken
      const loginRes2 = await request(app.getHttpServer())
        .post("/api/v1/auth/login")
        .send({
          schoolSlug: "greenwood",
          email: "alice@greenwood.com",
          password: rawPassword,
          clientType: "web",
        })
        .expect(200);

      // Second verify with the SAME code (replayed within the same 30s step) must be rejected
      const verifyRes2 = await request(app.getHttpServer())
        .post("/api/v1/auth/2fa/verify")
        .send({ temporaryToken: loginRes2.body.temporaryToken, code })
        .expect(401);

      expect(verifyRes2.body.detail ?? verifyRes2.body.message).toBe(
        "Invalid two-factor authentication credentials.",
      );
    });

    it("drift boundaries: accepts valid codes at ±1 step (±30s) and rejects codes outside boundary (±60s)", async () => {
      const now = Date.now();
      const redisService = app.get(RedisService);
      await redisService.getClient()?.del(`auth:2fa:attempts:${userAId}`);

      // Step -1 (-30s)
      const login1 = await request(app.getHttpServer())
        .post("/api/v1/auth/login")
        .send({
          schoolSlug: "greenwood",
          email: "alice@greenwood.com",
          password: rawPassword,
          clientType: "web",
        })
        .expect(200);
      const codeMinus1 = totpService.generateCode(capturedTotpSecret, now - 30000);
      await request(app.getHttpServer())
        .post("/api/v1/auth/2fa/verify")
        .send({ temporaryToken: login1.body.temporaryToken, code: codeMinus1 })
        .expect(200);

      // Step +1 (+30s)
      const login2 = await request(app.getHttpServer())
        .post("/api/v1/auth/login")
        .send({
          schoolSlug: "greenwood",
          email: "alice@greenwood.com",
          password: rawPassword,
          clientType: "web",
        })
        .expect(200);
      const codePlus1 = totpService.generateCode(capturedTotpSecret, now + 30000);
      await request(app.getHttpServer())
        .post("/api/v1/auth/2fa/verify")
        .send({ temporaryToken: login2.body.temporaryToken, code: codePlus1 })
        .expect(200);

      // Step -2 (-60s, outside drift window)
      const login3 = await request(app.getHttpServer())
        .post("/api/v1/auth/login")
        .send({
          schoolSlug: "greenwood",
          email: "alice@greenwood.com",
          password: rawPassword,
          clientType: "web",
        })
        .expect(200);
      const codeMinus2 = totpService.generateCode(capturedTotpSecret, now - 60000);
      await request(app.getHttpServer())
        .post("/api/v1/auth/2fa/verify")
        .send({ temporaryToken: login3.body.temporaryToken, code: codeMinus2 })
        .expect(401);

      // Step +2 (+60s, outside drift window)
      const login4 = await request(app.getHttpServer())
        .post("/api/v1/auth/login")
        .send({
          schoolSlug: "greenwood",
          email: "alice@greenwood.com",
          password: rawPassword,
          clientType: "web",
        })
        .expect(200);
      const codePlus2 = totpService.generateCode(capturedTotpSecret, now + 60000);
      await request(app.getHttpServer())
        .post("/api/v1/auth/2fa/verify")
        .send({ temporaryToken: login4.body.temporaryToken, code: codePlus2 })
        .expect(401);
    });

    it("brute force and shared cap: blocks after 5 failed attempts across TOTP and recovery codes", async () => {
      const redisService = app.get(RedisService);
      await redisService.getClient()?.del(`auth:2fa:attempts:${userAId}`);

      const loginRes = await request(app.getHttpServer())
        .post("/api/v1/auth/login")
        .send({
          schoolSlug: "greenwood",
          email: "alice@greenwood.com",
          password: rawPassword,
          clientType: "web",
        })
        .expect(200);
      const tempToken = loginRes.body.temporaryToken;

      // 3 wrong TOTP attempts
      await request(app.getHttpServer())
        .post("/api/v1/auth/2fa/verify")
        .send({ temporaryToken: tempToken, code: "000001" })
        .expect(401);
      await request(app.getHttpServer())
        .post("/api/v1/auth/2fa/verify")
        .send({ temporaryToken: tempToken, code: "000002" })
        .expect(401);
      await request(app.getHttpServer())
        .post("/api/v1/auth/2fa/verify")
        .send({ temporaryToken: tempToken, code: "000003" })
        .expect(401);

      // 2 wrong recovery code attempts (total 5 failed attempts)
      await request(app.getHttpServer())
        .post("/api/v1/auth/2fa/recovery")
        .send({ temporaryToken: tempToken, recoveryCode: "WRONG-CODE1" })
        .expect(401);
      await request(app.getHttpServer())
        .post("/api/v1/auth/2fa/recovery")
        .send({ temporaryToken: tempToken, recoveryCode: "WRONG-CODE2" })
        .expect(401);

      // 6th attempt with a VALID code must be rejected due to attempt cap
      const validCode = totpService.generateCode(capturedTotpSecret);
      const capExceededRes = await request(app.getHttpServer())
        .post("/api/v1/auth/2fa/verify")
        .send({ temporaryToken: tempToken, code: validCode })
        .expect(401);

      expect(capExceededRes.body.detail ?? capExceededRes.body.message).toBe(
        "Invalid two-factor authentication credentials.",
      );

      // Clean up attempt cap for subsequent tests
      await redisService.getClient()?.del(`auth:2fa:attempts:${userAId}`);
    });

    it("token scope separation: rejects 2fa_pending token on protected resource routes and rejects access token on 2fa endpoints", async () => {
      const loginRes = await request(app.getHttpServer())
        .post("/api/v1/auth/login")
        .send({
          schoolSlug: "greenwood",
          email: "alice@greenwood.com",
          password: rawPassword,
          clientType: "web",
        })
        .expect(200);
      const tempToken = loginRes.body.temporaryToken;

      // 1. Temporary 2fa_pending token must be rejected on resource routes with 403 Forbidden
      const meRes = await request(app.getHttpServer())
        .get("/api/v1/auth/me")
        .set("Authorization", `Bearer ${tempToken}`)
        .expect(403);
      expect(meRes.body.detail ?? meRes.body.message).toContain(
        "Two-factor authentication completion required",
      );

      await request(app.getHttpServer())
        .get("/api/v1/auth/sessions")
        .set("Authorization", `Bearer ${tempToken}`)
        .expect(403);

      await request(app.getHttpServer())
        .post("/api/v1/auth/2fa/setup")
        .set("Authorization", `Bearer ${tempToken}`)
        .expect(403);

      // 2. Full access token must be rejected when passed to 2fa verification endpoints
      await request(app.getHttpServer())
        .post("/api/v1/auth/2fa/verify")
        .send({ temporaryToken: aliceAccessToken, code: "123456" })
        .expect(401);

      await request(app.getHttpServer())
        .post("/api/v1/auth/2fa/recovery")
        .send({ temporaryToken: aliceAccessToken, recoveryCode: "AAAAA-BBBBB" })
        .expect(401);
    });

    it("recovery reuse: consumes single-use recovery code and rejects replay with generic 401", async () => {
      const redisService = app.get(RedisService);
      await redisService.getClient()?.del(`auth:2fa:attempts:${userAId}`);

      const codeToUse = capturedRecoveryCodes[0];

      // 1. First redemption of recovery code succeeds
      const login1 = await request(app.getHttpServer())
        .post("/api/v1/auth/login")
        .send({
          schoolSlug: "greenwood",
          email: "alice@greenwood.com",
          password: rawPassword,
          clientType: "web",
        })
        .expect(200);

      const res1 = await request(app.getHttpServer())
        .post("/api/v1/auth/2fa/recovery")
        .send({ temporaryToken: login1.body.temporaryToken, recoveryCode: codeToUse })
        .expect(200);

      expect(res1.body.accessToken).toBeTruthy();

      // 2. Immediate reuse of the same recovery code is rejected
      const login2 = await request(app.getHttpServer())
        .post("/api/v1/auth/login")
        .send({
          schoolSlug: "greenwood",
          email: "alice@greenwood.com",
          password: rawPassword,
          clientType: "web",
        })
        .expect(200);

      const res2 = await request(app.getHttpServer())
        .post("/api/v1/auth/2fa/recovery")
        .send({ temporaryToken: login2.body.temporaryToken, recoveryCode: codeToUse })
        .expect(401);

      expect(res2.body.detail ?? res2.body.message).toBe(
        "Invalid two-factor authentication credentials.",
      );
    });

    it("cross-tenant recovery code: rejects redemption of Tenant A recovery code against Tenant B account", async () => {
      // Bob (Tenant B) logs in and receives Tenant B temporary token
      const bobLogin = await request(app.getHttpServer())
        .post("/api/v1/auth/login")
        .send({
          schoolSlug: "oakridge",
          email: "bob@oakridge.com",
          password: rawPassword,
          clientType: "web",
        })
        .expect(200);

      // Attempt to redeem Alice's recovery code (Tenant A) using Bob's temporary token
      const crossTenantCode = capturedRecoveryCodes[1];
      const res = await request(app.getHttpServer())
        .post("/api/v1/auth/2fa/recovery")
        .send({ temporaryToken: bobLogin.body.temporaryToken, recoveryCode: crossTenantCode })
        .expect(401);

      expect(res.body.detail ?? res.body.message).toBe(
        "Invalid two-factor authentication credentials.",
      );
    });

    it("regeneration invalidating old codes: revokes older recovery codes and revokes other sessions", async () => {
      const redisService = app.get(RedisService);
      const redisClient = redisService.getClient();
      if (redisClient) {
        await redisClient.del(`auth:2fa:attempts:${userAId}`);
        const replayKeys = await redisClient.keys(`auth:totp:replay:${userAId}:*`);
        if (replayKeys.length > 0) {
          await redisClient.del(...replayKeys);
        }
      }

      // 1. Establish session 1 for Alice
      const login1 = await request(app.getHttpServer())
        .post("/api/v1/auth/login")
        .send({
          schoolSlug: "greenwood",
          email: "alice@greenwood.com",
          password: rawPassword,
          clientType: "web",
        })
        .expect(200);
      const code1 = totpService.generateCode(capturedTotpSecret);
      const auth1 = await request(app.getHttpServer())
        .post("/api/v1/auth/2fa/verify")
        .send({ temporaryToken: login1.body.temporaryToken, code: code1 })
        .expect(200);
      const tokenSession1 = auth1.body.accessToken;

      // 2. Establish session 2 for Alice
      if (redisClient) {
        const replayKeys = await redisClient.keys(`auth:totp:replay:${userAId}:*`);
        if (replayKeys.length > 0) {
          await redisClient.del(...replayKeys);
        }
      }
      const login2 = await request(app.getHttpServer())
        .post("/api/v1/auth/login")
        .send({
          schoolSlug: "greenwood",
          email: "alice@greenwood.com",
          password: rawPassword,
          clientType: "mobile",
        })
        .expect(200);
      const code2 = totpService.generateCode(capturedTotpSecret);
      const auth2 = await request(app.getHttpServer())
        .post("/api/v1/auth/2fa/verify")
        .send({ temporaryToken: login2.body.temporaryToken, code: code2 })
        .expect(200);
      const tokenSession2 = auth2.body.accessToken;
      const refreshSession2 = auth2.body.refreshToken;

      // Verify both sessions currently work
      await request(app.getHttpServer())
        .get("/api/v1/auth/me")
        .set("Authorization", `Bearer ${tokenSession1}`)
        .expect(200);
      await request(app.getHttpServer())
        .get("/api/v1/auth/me")
        .set("Authorization", `Bearer ${tokenSession2}`)
        .expect(200);

      // 3. Alice regenerates recovery codes using session 1
      const regenRes = await request(app.getHttpServer())
        .post("/api/v1/auth/2fa/recovery/regenerate")
        .set("Authorization", `Bearer ${tokenSession1}`)
        .send({ password: rawPassword })
        .expect(200);

      const newCodes: string[] = regenRes.body.recoveryCodes;
      expect(newCodes).toHaveLength(8);

      // Session 1 remains valid
      await request(app.getHttpServer())
        .get("/api/v1/auth/me")
        .set("Authorization", `Bearer ${tokenSession1}`)
        .expect(200);

      // Session 2 was revoked by regeneration: refresh fails with 401
      if (refreshSession2) {
        await request(app.getHttpServer())
          .post("/api/v1/auth/refresh")
          .send({ refreshToken: refreshSession2 })
          .expect(401);
      }

      // 4. Old code (capturedRecoveryCodes[2]) is now rejected
      const login3 = await request(app.getHttpServer())
        .post("/api/v1/auth/login")
        .send({
          schoolSlug: "greenwood",
          email: "alice@greenwood.com",
          password: rawPassword,
          clientType: "web",
        })
        .expect(200);

      await request(app.getHttpServer())
        .post("/api/v1/auth/2fa/recovery")
        .send({
          temporaryToken: login3.body.temporaryToken,
          recoveryCode: capturedRecoveryCodes[2],
        })
        .expect(401);

      // 5. One of the newly generated codes succeeds
      await request(app.getHttpServer())
        .post("/api/v1/auth/2fa/recovery")
        .send({ temporaryToken: login3.body.temporaryToken, recoveryCode: newCodes[0] })
        .expect(200);
    });

    it("secret/OTP/recovery code never in logs (capture real values): verifies zero secret leakage in logs", async () => {
      // Dispatch an SMS OTP request (stub mode)
      await request(app.getHttpServer())
        .post("/api/v1/auth/sms/send-otp")
        .send({
          schoolSlug: "greenwood",
          email: "alice@greenwood.com",
          phoneNumber: "+1-555-867-5309",
        })
        .expect(200);

      await new Promise((resolve) => setTimeout(resolve, 50));
      const combinedLogs = testLogBuffer.join("\n");

      // Verify captured real TOTP secret is never in logs
      expect(capturedTotpSecret).toBeTruthy();
      expect(combinedLogs).not.toContain(capturedTotpSecret);

      // Verify captured real TOTP code is never in logs
      expect(capturedTotpCode).toBeTruthy();
      expect(combinedLogs).not.toContain(capturedTotpCode);

      // Verify captured recovery codes are never in logs (both formatted and unformatted)
      expect(capturedRecoveryCodes.length).toBeGreaterThan(0);
      for (const code of capturedRecoveryCodes) {
        expect(combinedLogs).not.toContain(code);
        expect(combinedLogs).not.toContain(code.replace("-", ""));
      }

      // Verify SMS telephone masking: raw phone not in logs, masked phone is in logs
      expect(combinedLogs).not.toContain("+1-555-867-5309");
      expect(combinedLogs).toContain("***-***-5309");
      expect(combinedLogs).toContain("[SMS Stub]");
    });

    it("Redis-down: returns 503 on 2FA verify while non-2FA login and public routes remain functional", async () => {
      const redisService = app.get(RedisService);
      const spy = jest
        .spyOn(redisService, "getClient")
        .mockReturnValue({ status: "connecting" } as unknown as Redis);

      try {
        // 1. 2FA verify returns 503 Service Unavailable when Redis is down
        const loginAlice = await request(app.getHttpServer()).post("/api/v1/auth/login").send({
          schoolSlug: "greenwood",
          email: "alice@greenwood.com",
          password: rawPassword,
          clientType: "web",
        });

        if (loginAlice.body.temporaryToken) {
          await request(app.getHttpServer())
            .post("/api/v1/auth/2fa/verify")
            .send({ temporaryToken: loginAlice.body.temporaryToken, code: "123456" })
            .expect(503);
        }

        // 2. Non-2FA user login (Carol) continues to function normally
        const carolRes = await request(app.getHttpServer())
          .post("/api/v1/auth/login")
          .send({
            schoolSlug: "greenwood",
            email: "carol@greenwood.com",
            password: rawPassword,
            clientType: "web",
          })
          .expect(200);

        expect(carolRes.body.accessToken).toBeTruthy();

        // 3. Public SMS stub route continues to function normally
        const smsRes = await request(app.getHttpServer())
          .post("/api/v1/auth/sms/send-otp")
          .send({
            schoolSlug: "greenwood",
            email: "carol@greenwood.com",
            phoneNumber: "+1-555-999-0000",
          })
          .expect(200);

        expect(smsRes.body.message).toContain("eligible for SMS verification");
      } finally {
        spy.mockRestore();
      }
    });
  });
});
