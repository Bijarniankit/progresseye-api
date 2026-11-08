import { ForbiddenException, NotFoundException, UnauthorizedException } from "@nestjs/common";
import { Test, type TestingModule } from "@nestjs/testing";
import { TenantContextService } from "../../../common/request-context/tenant-context.service";
import { AppConfigService } from "../../../config/config.service";
import { AbusePreventionService } from "../domain/abuse-prevention.service";
import { PasswordService } from "../domain/password.service";
import { TokenService } from "../domain/token.service";
import { SessionRepository } from "../infra/session.repository";
import { AuthService } from "./auth.service";

describe("AuthService", () => {
  let service: AuthService;
  let mockSessionRepo: Partial<jest.Mocked<SessionRepository>>;
  let mockPasswordService: Partial<jest.Mocked<PasswordService>>;
  let mockTokenService: Partial<jest.Mocked<TokenService>>;
  let mockAbuseService: Partial<jest.Mocked<AbusePreventionService>>;
  let mockConfig: { get: jest.Mock };

  const schoolId = "018f0000-0000-7000-8000-000000000001";
  const userId = "018f0000-0000-7000-8000-000000000002";
  const sessionId = "018f0000-0000-7000-8000-000000000003";
  const familyId = "018f0000-0000-7000-8000-000000000004";

  beforeEach(async () => {
    mockConfig = {
      get: jest.fn().mockImplementation((key: string) => {
        if (key === "CORS_ORIGIN") return "https://app.progresseye.com";
        if (key === "AUTH_LOG_HMAC_SECRET") return "test-log-hmac-secret-min16ch";
        return undefined;
      }),
    };

    mockSessionRepo = {
      findSchoolBySlug: jest.fn(),
      findUserByEmail: jest.fn(),
      findUserById: jest.fn(),
      recordUserLogin: jest.fn(),
      createSession: jest.fn(),
      findSessionByTokenHash: jest.fn(),
      rotateSession: jest.fn(),
      revokeFamily: jest.fn(),
      revokeSessionByTokenHash: jest.fn(),
      revokeAllUserSessions: jest.fn(),
      getUserSessions: jest.fn(),
      revokeSessionById: jest.fn(),
      recordAuditLog: jest.fn(),
    };

    mockPasswordService = {
      hash: jest.fn(),
      verify: jest.fn(),
      verifyDummy: jest.fn(),
      validatePolicy: jest.fn(),
      evaluateStrength: jest.fn(),
    };

    mockTokenService = {
      generateRefreshToken: jest.fn().mockReturnValue("raw-refresh-token-123"),
      hashToken: jest.fn().mockReturnValue("token-hash-123"),
      buildCompoundRefreshToken: jest.fn().mockReturnValue(`${schoolId}.raw-refresh-token-123`),
      parseCompoundRefreshToken: jest.fn().mockReturnValue({
        schoolId,
        rawToken: "raw-refresh-token-123",
      }),
      createAccessToken: jest.fn().mockResolvedValue({ token: "jwt-access-token", expiresIn: 900 }),
      verifyAccessToken: jest.fn(),
    };

    mockAbuseService = {
      checkPreLogin: jest.fn().mockResolvedValue(undefined),
      recordFailedLogin: jest.fn().mockResolvedValue(1),
      recordSuccessfulLogin: jest.fn().mockResolvedValue(undefined),
      cacheSuccessorToken: jest.fn().mockResolvedValue(undefined),
      getSuccessorToken: jest.fn().mockResolvedValue(null),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthService,
        TenantContextService,
        { provide: SessionRepository, useValue: mockSessionRepo },
        { provide: PasswordService, useValue: mockPasswordService },
        { provide: TokenService, useValue: mockTokenService },
        { provide: AbusePreventionService, useValue: mockAbuseService },
        { provide: AppConfigService, useValue: mockConfig },
      ],
    }).compile();

    service = module.get<AuthService>(AuthService);
  });

  describe("CSRF Validation (Amendment 5)", () => {
    it("should allow matching Origin header", () => {
      expect(() => service.validateOrigin("https://app.progresseye.com")).not.toThrow();
    });

    it("should allow localhost in test/development", () => {
      expect(() => service.validateOrigin("http://localhost:3000")).not.toThrow();
    });

    it("should reject mismatched Origin with ForbiddenException", () => {
      expect(() => service.validateOrigin("https://evil-attacker.com")).toThrow(ForbiddenException);
    });
  });

  describe("login()", () => {
    it("should login successfully and return access token + compound refresh token", async () => {
      mockSessionRepo.findSchoolBySlug?.mockResolvedValue({
        id: schoolId,
        slug: "greenwood",
        name: "Greenwood High",
        isActive: true,
      });

      mockSessionRepo.findUserByEmail?.mockResolvedValue({
        id: userId,
        schoolId,
        email: "teacher@greenwood.com",
        passwordHash: "$argon2id$mock-hash",
        firstName: "Sarah",
        lastName: "Connor",
        isActive: true,
        mustChangePassword: false,
        userRoles: [{ role: { name: "Teacher" } }],
      } as any);

      mockPasswordService.verify?.mockResolvedValue(true);
      mockSessionRepo.createSession?.mockResolvedValue({
        id: sessionId,
        schoolId,
        userId,
        tokenHash: "token-hash-123",
        familyId,
      } as any);

      const result = await service.login(
        {
          schoolSlug: "greenwood",
          email: "teacher@greenwood.com",
          password: "ValidPassword123!",
          clientType: "web",
        },
        { ip: "127.0.0.1", userAgent: "JestTest" },
      );

      expect(result.accessToken).toBe("jwt-access-token");
      expect(result.compoundRefreshToken).toBe(`${schoolId}.raw-refresh-token-123`);
      expect(result.user.email).toBe("teacher@greenwood.com");
      expect(result.user.roles).toContain("Teacher");
      expect(mockAbuseService.recordSuccessfulLogin).toHaveBeenCalled();
    });

    it("should reject unknown school with timing-safe dummy verify and generic 401", async () => {
      mockSessionRepo.findSchoolBySlug?.mockResolvedValue(null);

      await expect(
        service.login(
          {
            schoolSlug: "unknown-school",
            email: "teacher@school.com",
            password: "password123",
            clientType: "web",
          },
          { ip: "127.0.0.1" },
        ),
      ).rejects.toThrow(UnauthorizedException);

      expect(mockPasswordService.verifyDummy).toHaveBeenCalled();
    });

    it("should reject incorrect password and record failed login", async () => {
      mockSessionRepo.findSchoolBySlug?.mockResolvedValue({
        id: schoolId,
        slug: "greenwood",
        name: "Greenwood High",
        isActive: true,
      });

      mockSessionRepo.findUserByEmail?.mockResolvedValue({
        id: userId,
        schoolId,
        email: "teacher@greenwood.com",
        passwordHash: "$argon2id$mock-hash",
        isActive: true,
      } as any);

      mockPasswordService.verify?.mockResolvedValue(false);

      await expect(
        service.login(
          {
            schoolSlug: "greenwood",
            email: "teacher@greenwood.com",
            password: "WrongPassword123!",
            clientType: "web",
          },
          { ip: "127.0.0.1" },
        ),
      ).rejects.toThrow(UnauthorizedException);

      expect(mockAbuseService.recordFailedLogin).toHaveBeenCalled();
    });
  });

  describe("refresh() with Grace Window & Reuse Detection", () => {
    it("should return cached successor token if duplicate request arrives within 10s grace window (Amendment 4)", async () => {
      mockAbuseService.getSuccessorToken?.mockResolvedValue({
        accessToken: "cached-access-token",
        expiresIn: 900,
        compoundRefreshToken: `${schoolId}.cached-refresh-token`,
      });

      const result = await service.refresh(`${schoolId}.raw-token`, {
        ip: "127.0.0.1",
        origin: "https://app.progresseye.com",
      });

      expect(result.accessToken).toBe("cached-access-token");
      expect(result.compoundRefreshToken).toBe(`${schoolId}.cached-refresh-token`);
      // Should NOT have queried DB or generated a second successor
      expect(mockSessionRepo.rotateSession).not.toHaveBeenCalled();
    });

    it("should detect token reuse (already revoked outside grace window) and revoke entire session family", async () => {
      mockAbuseService.getSuccessorToken?.mockResolvedValue(null); // Not in grace window
      mockSessionRepo.findSessionByTokenHash?.mockResolvedValue({
        id: sessionId,
        schoolId,
        userId,
        familyId,
        tokenHash: "token-hash-123",
        revokedAt: new Date(Date.now() - 30000), // Revoked 30 seconds ago
        expiresAt: new Date(Date.now() + 100000),
        user: { isActive: true },
      } as any);

      await expect(
        service.refresh(`${schoolId}.stolen-old-token`, {
          ip: "198.51.100.1",
          origin: "https://app.progresseye.com",
        }),
      ).rejects.toThrow(/Session revoked due to token reuse detection/);

      // Verify entire family is revoked
      expect(mockSessionRepo.revokeFamily).toHaveBeenCalledWith(schoolId, familyId);
    });

    it("should successfully rotate token when active and unrevoked", async () => {
      mockAbuseService.getSuccessorToken?.mockResolvedValue(null);
      mockSessionRepo.findSessionByTokenHash?.mockResolvedValue({
        id: sessionId,
        schoolId,
        userId,
        familyId,
        tokenHash: "token-hash-123",
        revokedAt: null,
        expiresAt: new Date(Date.now() + 1000000),
        clientType: "web",
        user: { isActive: true, deletedAt: null },
      } as any);

      mockSessionRepo.rotateSession?.mockResolvedValue({
        id: "new-session-id",
        schoolId,
        userId,
        familyId,
      } as any);

      const result = await service.refresh(`${schoolId}.valid-token`, {
        ip: "127.0.0.1",
        origin: "https://app.progresseye.com",
      });

      expect(result.accessToken).toBe("jwt-access-token");
      expect(mockSessionRepo.rotateSession).toHaveBeenCalled();
      expect(mockAbuseService.cacheSuccessorToken).toHaveBeenCalled();
    });
  });

  describe("logout() and logoutAll() (Amendment 9)", () => {
    it("should revoke session on logout", async () => {
      await service.logout(`${schoolId}.some-token`, { origin: "https://app.progresseye.com" });
      expect(mockSessionRepo.revokeSessionByTokenHash).toHaveBeenCalledWith(
        schoolId,
        "token-hash-123",
      );
    });

    it("should revoke all sessions for user on logoutAll within school context", async () => {
      mockSessionRepo.revokeAllUserSessions?.mockResolvedValue(3);

      const result = await service.logoutAll(schoolId, userId);
      expect(result.count).toBe(3);
      expect(mockSessionRepo.revokeAllUserSessions).toHaveBeenCalledWith(schoolId, userId);
    });
  });

  describe("Session Management", () => {
    it("should return sessions with isCurrent flag", async () => {
      mockSessionRepo.getUserSessions?.mockResolvedValue([
        {
          id: sessionId,
          clientType: "web",
          userAgent: "Mozilla",
          ipAddress: "127.0.0.1",
          createdAt: new Date(),
          expiresAt: new Date(),
        },
        {
          id: "other-session",
          clientType: "mobile",
          userAgent: "App",
          ipAddress: "127.0.0.1",
          createdAt: new Date(),
          expiresAt: new Date(),
        },
      ] as any);

      const sessions = await service.getSessions(schoolId, userId, sessionId);
      expect(sessions).toHaveLength(2);
      expect(sessions[0]?.isCurrent).toBe(true);
      expect(sessions[1]?.isCurrent).toBe(false);
    });

    it("should throw NotFoundException when revoking non-existent session", async () => {
      mockSessionRepo.revokeSessionById?.mockResolvedValue(false);

      await expect(service.revokeSession(schoolId, userId, "non-existent")).rejects.toThrow(
        NotFoundException,
      );
    });
  });
});
