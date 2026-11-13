import { BadRequestException, UnauthorizedException } from "@nestjs/common";
import { Test, TestingModule } from "@nestjs/testing";
import { SYSTEM_TENANT_ID } from "../../../common/request-context/tenant-context.service";
import { PrismaService } from "../../../infra/prisma/prisma.service";
import { AbusePreventionService } from "../../identity/domain/abuse-prevention.service";
import { PasswordService } from "../../identity/domain/password.service";
import { TokenService } from "../../identity/domain/token.service";
import { TotpService } from "../../identity/domain/totp.service";
import { SessionRepository } from "../../identity/infra/session.repository";
import { PlatformAuditService } from "./platform-audit.service";
import { PlatformAuthService } from "./platform-auth.service";

describe("PlatformAuthService", () => {
  let service: PlatformAuthService;
  let mockPrisma: any;
  let mockPasswordService: any;
  let mockTokenService: any;
  let mockTotpService: any;
  let mockSessionRepo: any;
  let mockPlatformAudit: any;
  let mockAbusePrevention: any;

  beforeEach(async () => {
    mockPrisma = {
      withTenant: jest.fn(),
    };
    mockPasswordService = {
      verify: jest.fn(),
    };
    mockTokenService = {
      createTemporaryPlatformTwoFactorToken: jest.fn(),
      createPlatformAccessToken: jest.fn(),
      verifyAccessToken: jest.fn(),
      generateRefreshToken: jest.fn().mockReturnValue("mock-refresh-token"),
      hashToken: jest.fn().mockReturnValue("mock-refresh-hash"),
    };
    mockTotpService = {
      generateTotpSetup: jest.fn(),
      encryptSecret: jest.fn().mockReturnValue({
        encryptedSecret: "enc",
        iv: "iv",
        authTag: "tag",
      }),
      decryptSecret: jest.fn().mockReturnValue("plain-base32-secret"),
      verifyCodeWithoutReplay: jest.fn(),
      generateRecoveryCodes: jest.fn().mockReturnValue({
        plainCodes: ["AAAAA-BBBBB"],
        hashedCodes: ["hashed-code"],
      }),
      checkAndIncrementAttemptCap: jest.fn().mockResolvedValue(true),
      verifyTotpCode: jest.fn(),
      hashRecoveryCode: jest.fn().mockReturnValue("hashed-rec"),
      resetAttemptCap: jest.fn().mockResolvedValue(undefined),
    };
    mockSessionRepo = {
      upsertTwoFactorSecret: jest.fn(),
      findTwoFactorSecret: jest.fn(),
      enableTwoFactor: jest.fn(),
      createSession: jest.fn().mockResolvedValue({ id: "session-uuid" }),
      verifyAndConsumeRecoveryCode: jest.fn(),
    };
    mockPlatformAudit = {
      recordEvent: jest.fn().mockResolvedValue(undefined),
    };
    mockAbusePrevention = {
      checkPreLogin: jest.fn().mockResolvedValue(undefined),
      recordFailedLogin: jest.fn().mockResolvedValue(undefined),
      recordSuccessfulLogin: jest.fn().mockResolvedValue(undefined),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PlatformAuthService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: PasswordService, useValue: mockPasswordService },
        { provide: TokenService, useValue: mockTokenService },
        { provide: TotpService, useValue: mockTotpService },
        { provide: SessionRepository, useValue: mockSessionRepo },
        { provide: PlatformAuditService, useValue: mockPlatformAudit },
        { provide: AbusePreventionService, useValue: mockAbusePrevention },
      ],
    }).compile();

    service = module.get<PlatformAuthService>(PlatformAuthService);
  });

  describe("login()", () => {
    it("should reject login if user not found", async () => {
      mockPrisma.withTenant.mockImplementation(async (_schoolId: string, fn: any) => {
        return fn({
          user: {
            findFirst: jest.fn().mockResolvedValue(null),
          },
        });
      });

      await expect(
        service.login(
          { email: "admin@platform.internal", password: "Password123!" },
          { ip: "127.0.0.1" },
        ),
      ).rejects.toThrow(UnauthorizedException);

      expect(mockPlatformAudit.recordEvent).toHaveBeenCalledWith(
        expect.objectContaining({ action: "PLATFORM_LOGIN_FAILURE" }),
      );
    });

    it("should issue platform_2fa_setup_pending if user has no 2FA configured", async () => {
      const mockUser = {
        id: "user-uuid",
        schoolId: SYSTEM_TENANT_ID,
        email: "admin@platform.internal",
        passwordHash: "argon2-hash",
        isActive: true,
        isTwoFactorEnabled: false,
        userRoles: [{ role: { slug: "platform_admin" } }],
      };

      mockPrisma.withTenant.mockImplementation(async (_schoolId: string, fn: any) => {
        return fn({
          user: {
            findFirst: jest.fn().mockResolvedValue(mockUser),
          },
        });
      });

      mockPasswordService.verify.mockResolvedValue(true);
      mockTokenService.createTemporaryPlatformTwoFactorToken.mockResolvedValue({
        token: "temp-setup-token",
        expiresIn: 300,
      });

      const res = await service.login(
        { email: "admin@platform.internal", password: "Password123!" },
        { ip: "127.0.0.1" },
      );

      expect(res.requires2Fa).toBe(true);
      expect(res.scope).toBe("platform_2fa_setup_pending");
      expect(res.temporaryToken).toBe("temp-setup-token");
      expect(mockPlatformAudit.recordEvent).toHaveBeenCalledWith(
        expect.objectContaining({ action: "PLATFORM_LOGIN_SETUP_CHALLENGE" }),
      );
    });

    it("should issue platform_2fa_pending if user has 2FA enabled", async () => {
      const mockUser = {
        id: "user-uuid",
        schoolId: SYSTEM_TENANT_ID,
        email: "admin@platform.internal",
        passwordHash: "argon2-hash",
        isActive: true,
        isTwoFactorEnabled: true,
        userRoles: [{ role: { slug: "platform_admin" } }],
      };

      mockPrisma.withTenant.mockImplementation(async (_schoolId: string, fn: any) => {
        return fn({
          user: {
            findFirst: jest.fn().mockResolvedValue(mockUser),
          },
        });
      });

      mockPasswordService.verify.mockResolvedValue(true);
      mockTokenService.createTemporaryPlatformTwoFactorToken.mockResolvedValue({
        token: "temp-verify-token",
        expiresIn: 300,
      });

      const res = await service.login(
        { email: "admin@platform.internal", password: "Password123!" },
        { ip: "127.0.0.1" },
      );

      expect(res.requires2Fa).toBe(true);
      expect(res.scope).toBe("platform_2fa_pending");
      expect(res.temporaryToken).toBe("temp-verify-token");
      expect(mockPlatformAudit.recordEvent).toHaveBeenCalledWith(
        expect.objectContaining({ action: "PLATFORM_LOGIN_CHALLENGE" }),
      );
    });
  });

  describe("setup2Fa()", () => {
    it("should reject token with incorrect scope", async () => {
      mockTokenService.verifyAccessToken.mockResolvedValue({
        sub: "user-uuid",
        schoolId: SYSTEM_TENANT_ID,
        scope: "platform_2fa_pending",
      });

      await expect(service.setup2Fa("wrong-scope-token")).rejects.toThrow(UnauthorizedException);
    });

    it("should generate TOTP setup details for valid platform_2fa_setup_pending token", async () => {
      mockTokenService.verifyAccessToken.mockResolvedValue({
        sub: "user-uuid",
        schoolId: SYSTEM_TENANT_ID,
        scope: "platform_2fa_setup_pending",
      });

      mockPrisma.withTenant.mockImplementation(async (_schoolId: string, fn: any) => {
        return fn({
          user: {
            findFirst: jest.fn().mockResolvedValue({
              id: "user-uuid",
              email: "admin@platform.internal",
              isActive: true,
            }),
          },
        });
      });

      mockTotpService.generateTotpSetup.mockReturnValue({
        secret: "plain-secret",
        uri: "otpauth://...",
      });

      const result = await service.setup2Fa("valid-token");
      expect(result.secret).toBe("plain-secret");
      expect(mockSessionRepo.upsertTwoFactorSecret).toHaveBeenCalled();
    });
  });

  describe("enable2Fa()", () => {
    it("should verify code, activate 2FA and return full platform session", async () => {
      mockTokenService.verifyAccessToken.mockResolvedValue({
        sub: "user-uuid",
        schoolId: SYSTEM_TENANT_ID,
        scope: "platform_2fa_setup_pending",
      });

      mockSessionRepo.findTwoFactorSecret.mockResolvedValue({
        encryptedSecret: "enc",
        iv: "iv",
        authTag: "tag",
      });

      mockTotpService.verifyCodeWithoutReplay.mockReturnValue(0);
      mockPrisma.withTenant.mockImplementation(async (_schoolId: string, fn: any) => {
        return fn({
          user: {
            findFirst: jest.fn().mockResolvedValue({
              id: "user-uuid",
              email: "admin@platform.internal",
              firstName: "Admin",
              lastName: "User",
              isActive: true,
            }),
          },
        });
      });

      mockTokenService.createPlatformAccessToken.mockResolvedValue({
        token: "platform-access-token",
        expiresIn: 900,
      });

      const result = await service.enable2Fa(
        "valid-token",
        { code: "123456" },
        { ip: "127.0.0.1" },
      );

      expect(result.accessToken).toBe("platform-access-token");
      expect(result.recoveryCodes).toEqual(["AAAAA-BBBBB"]);
      expect(mockPlatformAudit.recordEvent).toHaveBeenCalledWith(
        expect.objectContaining({ action: "PLATFORM_2FA_ENABLED" }),
      );
      expect(mockPlatformAudit.recordEvent).toHaveBeenCalledWith(
        expect.objectContaining({ action: "PLATFORM_LOGIN_SUCCESS" }),
      );
    });
  });
});
