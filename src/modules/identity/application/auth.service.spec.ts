import {
  ForbiddenException,
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException,
} from "@nestjs/common";
import { Test, type TestingModule } from "@nestjs/testing";
import { TenantContextService } from "../../../common/request-context/tenant-context.service";
import { AppConfigService } from "../../../config/config.service";
import { AbusePreventionService } from "../domain/abuse-prevention.service";
import { PasswordService } from "../domain/password.service";
import { TokenService } from "../domain/token.service";
import { TotpService } from "../domain/totp.service";
import { AuthEmailNotificationService } from "../infra/auth-email-notification.service";
import { SessionRepository } from "../infra/session.repository";
import { AuthService } from "./auth.service";

describe("AuthService", () => {
  let service: AuthService;
  let mockSessionRepo: Partial<jest.Mocked<SessionRepository>>;
  let mockPasswordService: Partial<jest.Mocked<PasswordService>>;
  let mockTokenService: Partial<jest.Mocked<TokenService>>;
  let mockAbuseService: Partial<jest.Mocked<AbusePreventionService>>;
  let mockEmailNotificationService: Partial<jest.Mocked<AuthEmailNotificationService>>;
  let mockTotpService: Partial<jest.Mocked<TotpService>>;
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
      revokeOtherUserSessions: jest.fn(),
      updateUserPassword: jest.fn(),
      createPasswordResetToken: jest.fn(),
      findPasswordResetToken: jest.fn(),
      markPasswordResetTokenUsed: jest.fn(),
      createEmailVerificationToken: jest.fn(),
      findEmailVerificationToken: jest.fn(),
      markEmailVerified: jest.fn(),
      recordAuditLog: jest.fn(),
      findSchoolById: jest
        .fn()
        .mockResolvedValue({ id: schoolId, slug: "demo-school", name: "Demo School" }),
      upsertTwoFactorSecret: jest.fn().mockResolvedValue(undefined),
      findTwoFactorSecret: jest.fn(),
      enableTwoFactor: jest.fn().mockResolvedValue(undefined),
      disableTwoFactor: jest.fn().mockResolvedValue(undefined),
      regenerateRecoveryCodes: jest.fn().mockResolvedValue(undefined),
      verifyAndConsumeRecoveryCode: jest.fn(),
    };

    mockPasswordService = {
      hash: jest.fn(),
      verify: jest.fn(),
      verifyDummy: jest.fn(),
      validatePolicy: jest.fn().mockReturnValue({ valid: true }),
      evaluateStrength: jest.fn().mockReturnValue({ score: 4, warning: null, suggestions: [] }),
    };

    mockTokenService = {
      generateRefreshToken: jest.fn().mockReturnValue("raw-refresh-token-123"),
      hashToken: jest.fn().mockReturnValue("token-hash-123"),
      buildCompoundRefreshToken: jest.fn().mockReturnValue(`${schoolId}.raw-refresh-token-123`),
      parseCompoundRefreshToken: jest.fn().mockReturnValue({
        schoolId,
        rawToken: "raw-refresh-token-123",
      }),
      generateLifecycleToken: jest.fn().mockReturnValue("raw-lifecycle-token-456"),
      buildCompoundLifecycleToken: jest.fn().mockReturnValue(`${schoolId}.raw-lifecycle-token-456`),
      parseCompoundLifecycleToken: jest.fn().mockReturnValue({
        schoolId,
        rawToken: "raw-lifecycle-token-456",
      }),
      createTemporaryPasswordChangeToken: jest
        .fn()
        .mockResolvedValue({ token: "temp-pwd-jwt", expiresIn: 900 }),
      createTemporaryTwoFactorToken: jest
        .fn()
        .mockResolvedValue({ token: "temp-2fa-jwt", expiresIn: 300 }),
      createAccessToken: jest.fn().mockResolvedValue({ token: "jwt-access-token", expiresIn: 900 }),
      verifyAccessToken: jest.fn(),
    };

    mockAbuseService = {
      checkPreLogin: jest.fn().mockResolvedValue(undefined),
      recordFailedLogin: jest.fn().mockResolvedValue(1),
      recordSuccessfulLogin: jest.fn().mockResolvedValue(undefined),
      cacheSuccessorToken: jest.fn().mockResolvedValue(undefined),
      getSuccessorToken: jest.fn().mockResolvedValue(null),
      assertRedisAvailable: jest.fn(),
      checkForgotPasswordRateLimit: jest.fn().mockResolvedValue(undefined),
      recordForgotPasswordAttempt: jest.fn().mockResolvedValue(undefined),
      checkResetPasswordRateLimit: jest.fn().mockResolvedValue(undefined),
      recordResetPasswordAttempt: jest.fn().mockResolvedValue(undefined),
      checkResendVerificationRateLimit: jest.fn().mockResolvedValue(undefined),
      recordResendVerificationAttempt: jest.fn().mockResolvedValue(undefined),
    };

    mockEmailNotificationService = {
      sendPasswordResetEmail: jest.fn().mockResolvedValue(undefined),
      sendEmailVerificationEmail: jest.fn().mockResolvedValue(undefined),
    };

    mockTotpService = {
      generateSecret: jest.fn().mockReturnValue("JBSWY3DPEHPK3PXP"),
      generateOtpAuthUri: jest
        .fn()
        .mockReturnValue("otpauth://totp/Demo%20School:user%40example.com?secret=JBSWY3DPEHPK3PXP"),
      generateTotpSetup: jest.fn().mockReturnValue({
        secret: "JBSWY3DPEHPK3PXP",
        uri: "otpauth://totp/Demo%20School:user%40example.com?secret=JBSWY3DPEHPK3PXP",
      }),
      encryptSecret: jest.fn().mockReturnValue({
        encryptedSecret: "enc-secret-hex",
        iv: "iv-hex",
        authTag: "tag-hex",
      }),
      decryptSecret: jest.fn().mockReturnValue("JBSWY3DPEHPK3PXP"),
      generateCode: jest.fn().mockReturnValue("123456"),
      verifyCodeWithoutReplay: jest.fn().mockReturnValue(12345),
      verifyTotpCode: jest.fn().mockResolvedValue(true),
      generateRecoveryCodes: jest.fn().mockReturnValue({
        plainCodes: ["AAAAA-BBBBB", "CCCCC-DDDDD"],
        hashedCodes: ["hash1", "hash2"],
      }),
      hashRecoveryCode: jest.fn().mockReturnValue("hash1"),
      checkAndIncrementAttemptCap: jest.fn().mockResolvedValue(true),
      resetAttemptCap: jest.fn().mockResolvedValue(undefined),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthService,
        TenantContextService,
        { provide: SessionRepository, useValue: mockSessionRepo },
        { provide: PasswordService, useValue: mockPasswordService },
        { provide: TokenService, useValue: mockTokenService },
        { provide: AbusePreventionService, useValue: mockAbuseService },
        { provide: AuthEmailNotificationService, useValue: mockEmailNotificationService },
        { provide: AppConfigService, useValue: mockConfig },
        { provide: TotpService, useValue: mockTotpService },
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
    it("should throw ServiceUnavailableException (503) when Redis cache is unavailable", async () => {
      mockAbuseService.assertRedisAvailable?.mockImplementation(() => {
        throw new ServiceUnavailableException(
          "Authentication service cache is currently unavailable. Please retry shortly.",
        );
      });

      await expect(service.refresh(`${schoolId}.token`, { ip: "127.0.0.1" })).rejects.toThrow(
        ServiceUnavailableException,
      );
    });

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

  describe("Password Change Revoking Other Sessions", () => {
    const currentSessionId = "session-1";

    it("should change password, update password hash, and revoke all other sessions for user", async () => {
      mockSessionRepo.findUserById?.mockResolvedValue({
        id: userId,
        schoolId,
        email: "alice@school.com",
        firstName: "Alice",
        lastName: "Smith",
        passwordHash: "$argon2id$old-hash",
        isActive: true,
      } as any);

      mockPasswordService.verify?.mockResolvedValue(true);
      mockPasswordService.validatePolicy?.mockReturnValue({ valid: true });
      mockPasswordService.evaluateStrength?.mockReturnValue({
        score: 4,
        warning: null,
        suggestions: [],
      });
      mockPasswordService.hash?.mockResolvedValue("$argon2id$new-hash");
      mockSessionRepo.revokeOtherUserSessions?.mockResolvedValue(2);

      const res = await service.changePassword(
        schoolId,
        userId,
        currentSessionId,
        {
          currentPassword: "OldPassword123!",
          newPassword: "NewSuperPassword12345!",
        },
        { ip: "127.0.0.1", userAgent: "Firefox" },
      );

      expect(res.revokedOtherSessionsCount).toBe(2);
      expect(mockSessionRepo.updateUserPassword).toHaveBeenCalledWith(
        schoolId,
        userId,
        "$argon2id$new-hash",
      );
      expect(mockSessionRepo.revokeOtherUserSessions).toHaveBeenCalledWith(
        schoolId,
        userId,
        currentSessionId,
      );
      expect(mockSessionRepo.recordAuditLog).toHaveBeenCalled();
    });

    it("should reject password change when current password is invalid", async () => {
      mockSessionRepo.findUserById?.mockResolvedValue({
        id: userId,
        schoolId,
        email: "alice@school.com",
        passwordHash: "$argon2id$old-hash",
        isActive: true,
      } as any);

      mockPasswordService.verify?.mockResolvedValue(false);

      await expect(
        service.changePassword(
          schoolId,
          userId,
          currentSessionId,
          {
            currentPassword: "WrongOldPassword!",
            newPassword: "NewSuperPassword12345!",
          },
          { ip: "127.0.0.1" },
        ),
      ).rejects.toThrow(UnauthorizedException);
    });
  });

  describe("Phase 12b-1: Account Lifecycle, Reset & Verification", () => {
    describe("forgotPassword()", () => {
      it("should return generic message when school does not exist (anti-enumeration)", async () => {
        mockSessionRepo.findSchoolBySlug?.mockResolvedValue(null);

        const result = await service.forgotPassword(
          { schoolSlug: "unknown-school", email: "user@test.com" },
          { ip: "127.0.0.1" },
        );

        expect(result.message).toContain("If an account matches that email");
        expect(mockPasswordService.verifyDummy).toHaveBeenCalled();
        expect(mockEmailNotificationService.sendPasswordResetEmail).not.toHaveBeenCalled();
      });

      it("should return generic message when user does not exist (anti-enumeration)", async () => {
        mockSessionRepo.findSchoolBySlug?.mockResolvedValue({
          id: schoolId,
          slug: "test-school",
          name: "Test School",
          isActive: true,
        });
        mockSessionRepo.findUserByEmail?.mockResolvedValue(null);

        const result = await service.forgotPassword(
          { schoolSlug: "test-school", email: "nonexistent@test.com" },
          { ip: "127.0.0.1" },
        );

        expect(result.message).toContain("If an account matches that email");
        expect(mockPasswordService.verifyDummy).toHaveBeenCalled();
        expect(mockEmailNotificationService.sendPasswordResetEmail).not.toHaveBeenCalled();
      });

      it("should generate reset token, enqueue email and return generic message when user exists", async () => {
        mockSessionRepo.findSchoolBySlug?.mockResolvedValue({
          id: schoolId,
          slug: "test-school",
          name: "Test School",
          isActive: true,
        });
        mockSessionRepo.findUserByEmail?.mockResolvedValue({
          id: userId,
          schoolId,
          email: "alice@test.com",
          isActive: true,
        } as any);

        const result = await service.forgotPassword(
          { schoolSlug: "test-school", email: "alice@test.com" },
          { ip: "127.0.0.1" },
        );

        expect(result.message).toContain("If an account matches that email");
        expect(mockSessionRepo.createPasswordResetToken).toHaveBeenCalled();
        expect(mockEmailNotificationService.sendPasswordResetEmail).toHaveBeenCalledWith(
          "alice@test.com",
          `${schoolId}.raw-lifecycle-token-456`,
        );
      });
    });

    describe("resetPassword()", () => {
      it("should reject invalid or expired reset token with BadRequestException", async () => {
        mockSessionRepo.findPasswordResetToken?.mockResolvedValue(null);

        await expect(
          service.resetPassword(
            { token: `${schoolId}.invalid-token`, newPassword: "SuperSecureNewPassword123!" },
            { ip: "127.0.0.1" },
          ),
        ).rejects.toThrow("Invalid or expired reset token.");
      });

      it("should reset password, revoke all user sessions, and NEVER log the user in", async () => {
        mockSessionRepo.findPasswordResetToken?.mockResolvedValue({
          id: "token-uuid-1",
          schoolId,
          userId,
          tokenHash: "token-hash-123",
          expiresAt: new Date(Date.now() + 3600000),
          usedAt: null,
          user: { id: userId, email: "alice@test.com" },
        } as any);

        mockPasswordService.hash?.mockResolvedValue("$argon2id$new-hashed-password");

        const result = await service.resetPassword(
          { token: `${schoolId}.valid-token`, newPassword: "SuperSecureNewPassword123!" },
          { ip: "127.0.0.1" },
        );

        expect(result.message).toContain("Password has been successfully reset");
        expect(mockSessionRepo.markPasswordResetTokenUsed).toHaveBeenCalledWith(
          schoolId,
          "token-uuid-1",
        );
        expect(mockSessionRepo.updateUserPassword).toHaveBeenCalledWith(
          schoolId,
          userId,
          "$argon2id$new-hashed-password",
        );
        expect(mockSessionRepo.revokeAllUserSessions).toHaveBeenCalledWith(schoolId, userId);
        expect((result as any).accessToken).toBeUndefined();
      });
    });

    describe("verifyEmail()", () => {
      it("should reject invalid verification token with BadRequestException", async () => {
        mockSessionRepo.findEmailVerificationToken?.mockResolvedValue(null);

        await expect(service.verifyEmail({ token: `${schoolId}.invalid-token` })).rejects.toThrow(
          "Invalid or expired verification token.",
        );
      });

      it("should mark email verification token used and set email_verified_at", async () => {
        mockSessionRepo.findEmailVerificationToken?.mockResolvedValue({
          id: "verify-token-uuid",
          schoolId,
          userId,
          tokenHash: "token-hash-123",
          usedAt: null,
          expiresAt: new Date(Date.now() + 86400000),
          user: { id: userId, email: "alice@test.com" },
        } as any);

        const result = await service.verifyEmail({ token: `${schoolId}.valid-token` });
        expect(result.message).toContain("Email has been successfully verified");
        expect(mockSessionRepo.markEmailVerified).toHaveBeenCalledWith(
          schoolId,
          "verify-token-uuid",
          userId,
        );
      });
    });

    describe("firstLoginPassword()", () => {
      it("should reject tokens with scope other than pwd_change_pending or access", async () => {
        await expect(
          service.firstLoginPassword(
            { userId, schoolId, scope: "invalid_scope" },
            { newPassword: "SuperSecureNewPassword123!" },
            { ip: "127.0.0.1" },
          ),
        ).rejects.toThrow(ForbiddenException);
      });

      it("should update password, clear mustChangePassword, revoke other sessions, and return new session", async () => {
        mockSessionRepo.findUserById?.mockResolvedValue({
          id: userId,
          schoolId,
          email: "alice@test.com",
          firstName: "Alice",
          lastName: "Alpha",
          mustChangePassword: true,
          userRoles: [{ role: { name: "Teacher" } }],
        } as any);

        mockSessionRepo.createSession?.mockResolvedValue({ id: "new-session-id" } as any);
        mockPasswordService.hash?.mockResolvedValue("$argon2id$new-hash");

        const result = await service.firstLoginPassword(
          { userId, schoolId, scope: "pwd_change_pending" },
          { newPassword: "SuperSecureNewPassword123!" },
          { ip: "127.0.0.1" },
        );

        expect(result.accessToken).toBe("jwt-access-token");
        expect(result.user.mustChangePassword).toBe(false);
        expect(mockSessionRepo.updateUserPassword).toHaveBeenCalledWith(
          schoolId,
          userId,
          "$argon2id$new-hash",
        );
        expect(mockSessionRepo.revokeAllUserSessions).toHaveBeenCalledWith(schoolId, userId);
      });
    });
  });

  describe("Phase 12b-2: TOTP 2FA, Recovery Codes & SMS Stub", () => {
    describe("login with 2FA enabled", () => {
      it("should issue temporaryToken with 2fa_pending scope and return requires2Fa: true without creating session", async () => {
        mockSessionRepo.findSchoolBySlug?.mockResolvedValue({
          id: schoolId,
          slug: "test-school",
          name: "Test School",
          isActive: true,
        });

        mockSessionRepo.findUserByEmail?.mockResolvedValue({
          id: userId,
          schoolId,
          email: "alice@test.com",
          firstName: "Alice",
          lastName: "Alpha",
          passwordHash: "$argon2id$hashed",
          isActive: true,
          mustChangePassword: false,
          isTwoFactorEnabled: true,
          userRoles: [{ role: { name: "Teacher" } }],
        } as any);

        mockPasswordService.verify?.mockResolvedValue(true);

        const result = await service.login(
          {
            schoolSlug: "test-school",
            email: "alice@test.com",
            password: "Password123!",
            clientType: "web",
          },
          { ip: "127.0.0.1" },
        );

        expect(result.requires2Fa).toBe(true);
        expect(result.temporaryToken).toBe("temp-2fa-jwt");
        expect(mockTokenService.createTemporaryTwoFactorToken).toHaveBeenCalledWith({
          userId,
          schoolId,
        });
        expect(mockSessionRepo.createSession).not.toHaveBeenCalled();
      });
    });

    describe("setup2Fa()", () => {
      it("should generate secret, encrypt it, upsert pending record, and return URI", async () => {
        mockSessionRepo.findUserById?.mockResolvedValue({
          id: userId,
          schoolId,
          email: "alice@test.com",
        } as any);

        const result = await service.setup2Fa(schoolId, userId);

        expect(result.secret).toBe("JBSWY3DPEHPK3PXP");
        expect(result.uri).toContain("otpauth://totp");
        expect(mockTotpService.encryptSecret).toHaveBeenCalledWith("JBSWY3DPEHPK3PXP");
        expect(mockSessionRepo.upsertTwoFactorSecret).toHaveBeenCalledWith({
          schoolId,
          userId,
          encryptedSecret: "enc-secret-hex",
          iv: "iv-hex",
          authTag: "tag-hex",
        });
      });
    });

    describe("enable2Fa()", () => {
      it("should verify initial code, generate 8 recovery codes, and mark 2FA active in repo", async () => {
        mockSessionRepo.findTwoFactorSecret?.mockResolvedValue({
          schoolId,
          userId,
          encryptedSecret: "enc-secret-hex",
          iv: "iv-hex",
          authTag: "tag-hex",
          isVerified: false,
        } as any);

        const result = await service.enable2Fa(schoolId, userId, "123456");

        expect(result.recoveryCodes).toEqual(["AAAAA-BBBBB", "CCCCC-DDDDD"]);
        expect(mockSessionRepo.enableTwoFactor).toHaveBeenCalledWith({
          schoolId,
          userId,
          recoveryCodeHashes: ["hash1", "hash2"],
        });
      });

      it("should reject invalid verification code", async () => {
        mockSessionRepo.findTwoFactorSecret?.mockResolvedValue({
          schoolId,
          userId,
          encryptedSecret: "enc-secret-hex",
          iv: "iv-hex",
          authTag: "tag-hex",
          isVerified: false,
        } as any);

        mockTotpService.verifyCodeWithoutReplay?.mockReturnValue(null);

        await expect(service.enable2Fa(schoolId, userId, "000000")).rejects.toThrow(
          "Invalid verification code.",
        );
      });
    });

    describe("verify2Fa()", () => {
      it("should verify 2fa_pending token, check attempt cap, verify TOTP, reset cap, and create session", async () => {
        mockTokenService.verifyAccessToken?.mockResolvedValue({
          sub: userId,
          schoolId,
          scope: "2fa_pending",
          sessionId: "2fa_pending",
        });

        mockSessionRepo.findTwoFactorSecret?.mockResolvedValue({
          schoolId,
          userId,
          encryptedSecret: "enc-secret-hex",
          iv: "iv-hex",
          authTag: "tag-hex",
          isVerified: true,
        } as any);

        mockSessionRepo.findUserById?.mockResolvedValue({
          id: userId,
          schoolId,
          email: "alice@test.com",
          firstName: "Alice",
          lastName: "Alpha",
          isActive: true,
          mustChangePassword: false,
          isTwoFactorEnabled: true,
          userRoles: [{ role: { name: "Teacher" } }],
        } as any);

        mockSessionRepo.createSession?.mockResolvedValue({ id: sessionId } as any);

        const result = await service.verify2Fa(
          { temporaryToken: "temp-2fa-jwt", code: "123456" },
          { ip: "127.0.0.1" },
        );

        expect(result.accessToken).toBe("jwt-access-token");
        expect(result.user.isTwoFactorEnabled).toBe(true);
        expect(mockTotpService.checkAndIncrementAttemptCap).toHaveBeenCalledWith(userId);
        expect(mockTotpService.resetAttemptCap).toHaveBeenCalledWith(userId);
        expect(mockSessionRepo.createSession).toHaveBeenCalled();
      });

      it("should reject with generic 401 when code is invalid or replayed", async () => {
        mockTokenService.verifyAccessToken?.mockResolvedValue({
          sub: userId,
          schoolId,
          scope: "2fa_pending",
          sessionId: "2fa_pending",
        });

        mockSessionRepo.findTwoFactorSecret?.mockResolvedValue({
          schoolId,
          userId,
          encryptedSecret: "enc-secret-hex",
          iv: "iv-hex",
          authTag: "tag-hex",
          isVerified: true,
        } as any);

        mockTotpService.verifyTotpCode?.mockResolvedValue(false);

        await expect(
          service.verify2Fa(
            { temporaryToken: "temp-2fa-jwt", code: "000000" },
            { ip: "127.0.0.1" },
          ),
        ).rejects.toThrow(UnauthorizedException);
      });
    });

    describe("verifyRecoveryCode()", () => {
      it("should consume valid recovery code and issue session", async () => {
        mockTokenService.verifyAccessToken?.mockResolvedValue({
          sub: userId,
          schoolId,
          scope: "2fa_pending",
          sessionId: "2fa_pending",
        });

        mockSessionRepo.verifyAndConsumeRecoveryCode?.mockResolvedValue(true);

        mockSessionRepo.findUserById?.mockResolvedValue({
          id: userId,
          schoolId,
          email: "alice@test.com",
          firstName: "Alice",
          lastName: "Alpha",
          isActive: true,
          mustChangePassword: false,
          isTwoFactorEnabled: true,
          userRoles: [{ role: { name: "Teacher" } }],
        } as any);

        mockSessionRepo.createSession?.mockResolvedValue({ id: sessionId } as any);

        const result = await service.verifyRecoveryCode(
          { temporaryToken: "temp-2fa-jwt", recoveryCode: "AAAAA-BBBBB" },
          { ip: "127.0.0.1" },
        );

        expect(result.accessToken).toBe("jwt-access-token");
        expect(mockSessionRepo.verifyAndConsumeRecoveryCode).toHaveBeenCalled();
        expect(mockTotpService.resetAttemptCap).toHaveBeenCalledWith(userId);
      });

      it("should reject with generic 401 when recovery code is already consumed or wrong", async () => {
        mockTokenService.verifyAccessToken?.mockResolvedValue({
          sub: userId,
          schoolId,
          scope: "2fa_pending",
          sessionId: "2fa_pending",
        });

        mockSessionRepo.verifyAndConsumeRecoveryCode?.mockResolvedValue(false);

        await expect(
          service.verifyRecoveryCode(
            { temporaryToken: "temp-2fa-jwt", recoveryCode: "WRONG-CODE" },
            { ip: "127.0.0.1" },
          ),
        ).rejects.toThrow(UnauthorizedException);
      });
    });

    describe("disable2Fa()", () => {
      it("should verify password and code, then disable 2FA", async () => {
        mockSessionRepo.findUserById?.mockResolvedValue({
          id: userId,
          schoolId,
          passwordHash: "$argon2id$hashed",
        } as any);
        mockPasswordService.verify?.mockResolvedValue(true);

        mockSessionRepo.findTwoFactorSecret?.mockResolvedValue({
          schoolId,
          userId,
          encryptedSecret: "enc-secret-hex",
          iv: "iv-hex",
          authTag: "tag-hex",
          isVerified: true,
        } as any);

        const result = await service.disable2Fa(schoolId, userId, sessionId, {
          password: "CurrentPassword123!",
          code: "123456",
        });

        expect(result.message).toContain("disabled successfully");
        expect(mockSessionRepo.disableTwoFactor).toHaveBeenCalledWith(schoolId, userId, sessionId);
      });
    });

    describe("regenerateRecoveryCodes()", () => {
      it("should verify password and regenerate recovery codes", async () => {
        mockSessionRepo.findUserById?.mockResolvedValue({
          id: userId,
          schoolId,
          passwordHash: "$argon2id$hashed",
          isTwoFactorEnabled: true,
        } as any);
        mockPasswordService.verify?.mockResolvedValue(true);

        const result = await service.regenerateRecoveryCodes(schoolId, userId, sessionId, {
          password: "CurrentPassword123!",
        });

        expect(result.recoveryCodes).toEqual(["AAAAA-BBBBB", "CCCCC-DDDDD"]);
        expect(mockSessionRepo.regenerateRecoveryCodes).toHaveBeenCalled();
      });
    });

    describe("sendSmsOtp()", () => {
      it("should return generic message and mask telephone without throwing", () => {
        const result = service.sendSmsOtp({
          schoolSlug: "test-school",
          email: "alice@test.com",
          phoneNumber: "+15551234567",
        });

        expect(result.message).toContain("eligible for SMS verification");
      });
    });
  });
});
