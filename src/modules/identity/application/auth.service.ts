import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from "@nestjs/common";
import { TenantContextService } from "../../../common/request-context/tenant-context.service";
import { hmacHash } from "../../../common/utils/sanitization";
import { AppConfigService } from "../../../config/config.service";
import { AbusePreventionService } from "../domain/abuse-prevention.service";
import { PasswordService } from "../domain/password.service";
import { TokenService } from "../domain/token.service";
import { TotpService } from "../domain/totp.service";
import type { ChangePasswordDto } from "../dto/change-password.dto";
import type { Disable2FaDto } from "../dto/disable-2fa.dto";
import type { Enable2FaDto } from "../dto/enable-2fa.dto";
import type { FirstLoginPasswordDto } from "../dto/first-login-password.dto";
import type { ForgotPasswordDto } from "../dto/forgot-password.dto";
import type { LoginDto } from "../dto/login.dto";
import type { RecoveryCodeVerifyDto } from "../dto/recovery-code-verify.dto";
import type { RegenerateRecoveryCodesDto } from "../dto/regenerate-recovery-codes.dto";
import type { ResendVerificationDto } from "../dto/resend-verification.dto";
import type { ResetPasswordDto } from "../dto/reset-password.dto";
import type { SmsOtpDto } from "../dto/sms-otp.dto";
import type { TotpVerifyDto } from "../dto/totp-verify.dto";
import type { VerifyEmailDto } from "../dto/verify-email.dto";
import { AuthEmailNotificationService } from "../infra/auth-email-notification.service";
import { SessionRepository } from "../infra/session.repository";

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);
  private readonly corsOrigin: string;
  private readonly hmacSecret: string;

  constructor(
    private readonly sessionRepository: SessionRepository,
    private readonly passwordService: PasswordService,
    private readonly tokenService: TokenService,
    private readonly abusePreventionService: AbusePreventionService,
    private readonly tenantContext: TenantContextService,
    private readonly config: AppConfigService,
    private readonly authEmailNotificationService: AuthEmailNotificationService,
    private readonly totpService: TotpService,
  ) {
    this.corsOrigin = this.config.get("CORS_ORIGIN");
    this.hmacSecret = this.config.get("AUTH_LOG_HMAC_SECRET");
  }

  /**
   * Helper to validate Origin/Referer for CSRF defence on cookie-authenticated routes (Amendment 5).
   */
  validateOrigin(origin?: string, referer?: string): void {
    if (!origin && !referer) {
      // Direct API / mobile client without browser origin
      return;
    }
    const target = origin || referer || "";
    // Allow configured CORS origin or localhost in dev/test
    if (
      target.startsWith(this.corsOrigin) ||
      target.startsWith("http://localhost:") ||
      target.startsWith("http://127.0.0.1:")
    ) {
      return;
    }
    throw new ForbiddenException("CSRF protection: request origin does not match allowed origin");
  }

  /**
   * Login: resolves school by slug, checks anti-abuse lockout, verifies password timing-safely,
   * creates a session and returns an access token + compound refresh token.
   */
  async login(dto: LoginDto, meta: { userAgent?: string; ip: string }) {
    const slug = dto.schoolSlug.trim().toLowerCase();
    const email = dto.email.trim().toLowerCase();

    // 1. Resolve school by slug (public read policy on schools)
    const school = await this.sessionRepository.findSchoolBySlug(slug);
    if (!school) {
      // Timing-safe dummy check
      await this.passwordService.verifyDummy(dto.password);
      this.logger.warn({
        event: "platform_audit",
        action: "AUTH.LOGIN_UNKNOWN_SCHOOL",
        schoolSlug: slug,
        ipHmac: hmacHash(meta.ip, this.hmacSecret),
      });
      throw new UnauthorizedException("Invalid credentials.");
    }

    // 2. Anti-DoS Lockout & Rate Limit Check (Amendment 3)
    await this.abusePreventionService.checkPreLogin(meta.ip, email, school.id);

    // 3. Find user within school tenant context (RLS bound via withTenant)
    const user = await this.sessionRepository.findUserByEmail(school.id, email);
    if (!user || !user.isActive || !user.passwordHash) {
      await this.passwordService.verifyDummy(dto.password);
      await this.abusePreventionService.recordFailedLogin(meta.ip, email, school.id);
      throw new UnauthorizedException("Invalid credentials.");
    }

    // 4. Verify password with Argon2id
    const isValid = await this.passwordService.verify(user.passwordHash, dto.password);
    if (!isValid) {
      await this.abusePreventionService.recordFailedLogin(meta.ip, email, school.id);
      throw new UnauthorizedException("Invalid credentials.");
    }

    // 5. Successful login: reset abuse counters and update user login timestamp
    await this.abusePreventionService.recordSuccessfulLogin(meta.ip, email, school.id);
    await this.sessionRepository.recordUserLogin(school.id, user.id);

    const roles = user.userRoles.map((ur) => ur.role.name);

    // If two-factor authentication is enabled, issue restricted 2fa_pending token
    if (user.isTwoFactorEnabled) {
      const { token: temporaryToken, expiresIn: tempExpiresIn } =
        await this.tokenService.createTemporaryTwoFactorToken({
          userId: user.id,
          schoolId: school.id,
        });

      return {
        requires2Fa: true,
        temporaryToken,
        expiresIn: tempExpiresIn,
        user: {
          id: user.id,
          email: user.email,
          firstName: user.firstName,
          lastName: user.lastName,
          mustChangePassword: user.mustChangePassword,
          roles,
          isTwoFactorEnabled: true,
        },
      };
    }

    // If first-login forced password change is required, issue a restricted temporary token
    if (user.mustChangePassword) {
      const { token: temporaryToken, expiresIn: tempExpiresIn } =
        await this.tokenService.createTemporaryPasswordChangeToken({
          userId: user.id,
          schoolId: school.id,
        });

      return {
        mustChangePassword: true,
        temporaryToken,
        expiresIn: tempExpiresIn,
        user: {
          id: user.id,
          email: user.email,
          firstName: user.firstName,
          lastName: user.lastName,
          mustChangePassword: true,
          roles,
          isTwoFactorEnabled: false,
        },
      };
    }

    // 6. Create session
    const rawRefreshToken = this.tokenService.generateRefreshToken();
    const tokenHash = this.tokenService.hashToken(rawRefreshToken);
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000); // 30 days

    const session = await this.sessionRepository.createSession({
      schoolId: school.id,
      userId: user.id,
      tokenHash,
      clientType: dto.clientType,
      userAgent: meta.userAgent,
      ipAddress: meta.ip,
      expiresAt,
    });

    // 7. Sign access token via jose (15 min)
    const { token: accessToken, expiresIn } = await this.tokenService.createAccessToken({
      userId: user.id,
      schoolId: school.id,
      sessionId: session.id,
    });

    const compoundRefreshToken = this.tokenService.buildCompoundRefreshToken(
      school.id,
      rawRefreshToken,
    );

    // Audit event (Tenant Scoped)
    await this.sessionRepository.recordAuditLog({
      schoolId: school.id,
      actorId: user.id,
      action: "AUTH.LOGIN_SUCCESS",
      entityId: user.id,
      metadata: {
        sessionId: session.id,
        clientType: dto.clientType,
        ipHmac: hmacHash(meta.ip, this.hmacSecret),
      },
    });

    return {
      accessToken,
      expiresIn,
      compoundRefreshToken,
      user: {
        id: user.id,
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
        mustChangePassword: user.mustChangePassword,
        roles,
        isTwoFactorEnabled: user.isTwoFactorEnabled,
      },
    };
  }

  /**
   * Refresh: rotates refresh token, supports 10-second grace window returning the exact same successor,
   * detects family reuse and revokes entire family if replayed outside window.
   */
  async refresh(
    compoundRefreshToken: string,
    meta: { userAgent?: string; ip: string; origin?: string; referer?: string },
  ) {
    this.validateOrigin(meta.origin, meta.referer);
    await this.abusePreventionService.assertRedisAvailable();

    // 1. Split compound token: <schoolId>.<rawToken> (Amendment 2)
    const { schoolId, rawToken } =
      this.tokenService.parseCompoundRefreshToken(compoundRefreshToken);
    this.tenantContext.validateTenantId(schoolId);

    const tokenHash = this.tokenService.hashToken(rawToken);

    // 2. Grace window check (Amendment 4): return identical successor if requested in-window
    const cachedSuccessor = await this.abusePreventionService.getSuccessorToken(tokenHash);
    if (cachedSuccessor) {
      this.logger.debug(
        `Returning cached successor for token hash ${tokenHash.slice(0, 8)} within grace window.`,
      );
      return {
        accessToken: cachedSuccessor.accessToken as string,
        expiresIn: cachedSuccessor.expiresIn as number,
        compoundRefreshToken: cachedSuccessor.compoundRefreshToken as string,
      };
    }

    // 3. Find session under schoolId under RLS
    const session = await this.sessionRepository.findSessionByTokenHash(schoolId, tokenHash);
    if (!session) {
      throw new UnauthorizedException("Invalid refresh token");
    }

    // 4. Token Reuse Detection: if already revoked outside grace window, revoke entire family!
    if (session.revokedAt) {
      const revokedCount = await this.sessionRepository.revokeFamily(schoolId, session.familyId);
      this.logger.warn({
        event: "tenant_audit",
        action: "AUTH.TOKEN_REUSE_DETECTED",
        schoolId,
        familyId: session.familyId,
        revokedSessionsCount: revokedCount,
        ipHmac: hmacHash(meta.ip, this.hmacSecret),
      });

      await this.sessionRepository.recordAuditLog({
        schoolId,
        action: "AUTH.TOKEN_REUSE_DETECTED",
        entityId: session.userId,
        metadata: {
          familyId: session.familyId,
          revokedCount,
        },
      });

      throw new UnauthorizedException("Session revoked due to token reuse detection");
    }

    // 5. Expiration check
    if (session.expiresAt.getTime() <= Date.now()) {
      throw new UnauthorizedException("Refresh token has expired");
    }

    // 6. User active check
    if (!session.user.isActive || session.user.deletedAt) {
      throw new UnauthorizedException("Account is inactive");
    }

    // 7. Atomic rotation
    const newRawRefreshToken = this.tokenService.generateRefreshToken();
    const newTokenHash = this.tokenService.hashToken(newRawRefreshToken);
    const newExpiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

    const newSession = await this.sessionRepository.rotateSession(schoolId, session.id, {
      schoolId,
      userId: session.userId,
      tokenHash: newTokenHash,
      clientType: session.clientType,
      userAgent: meta.userAgent ?? session.userAgent,
      ipAddress: meta.ip,
      expiresAt: newExpiresAt,
      familyId: session.familyId,
      parentTokenHash: session.tokenHash,
    });

    // 8. Sign new access token
    const { token: accessToken, expiresIn } = await this.tokenService.createAccessToken({
      userId: session.userId,
      schoolId,
      sessionId: newSession.id,
    });

    const newCompoundRefreshToken = this.tokenService.buildCompoundRefreshToken(
      schoolId,
      newRawRefreshToken,
    );

    // 9. Cache successor for 10-second grace window (Amendment 4)
    await this.abusePreventionService.cacheSuccessorToken(
      tokenHash,
      {
        accessToken,
        expiresIn,
        compoundRefreshToken: newCompoundRefreshToken,
      },
      10,
    );

    await this.sessionRepository.recordAuditLog({
      schoolId,
      actorId: session.userId,
      action: "AUTH.TOKEN_ROTATED",
      entityId: session.userId,
      metadata: {
        familyId: session.familyId,
        oldSessionId: session.id,
        newSessionId: newSession.id,
      },
    });

    return {
      accessToken,
      expiresIn,
      compoundRefreshToken: newCompoundRefreshToken,
    };
  }

  /**
   * Logout: revokes the specific session matching the refresh token.
   */
  async logout(
    compoundRefreshToken?: string,
    meta?: { origin?: string; referer?: string },
  ): Promise<void> {
    if (meta) {
      this.validateOrigin(meta.origin, meta.referer);
    }
    if (!compoundRefreshToken) {
      return;
    }

    try {
      const { schoolId, rawToken } =
        this.tokenService.parseCompoundRefreshToken(compoundRefreshToken);
      this.tenantContext.validateTenantId(schoolId);
      const tokenHash = this.tokenService.hashToken(rawToken);
      await this.sessionRepository.revokeSessionByTokenHash(schoolId, tokenHash);
    } catch {
      // Fail safely without throwing on logout
    }
  }

  /**
   * Logout-All: revokes all active sessions for a user within a school (Tenant Scoped, Amendment 9).
   */
  async logoutAll(schoolId: string, userId: string): Promise<{ count: number }> {
    this.tenantContext.validateTenantId(schoolId);
    const count = await this.sessionRepository.revokeAllUserSessions(schoolId, userId);

    await this.sessionRepository.recordAuditLog({
      schoolId,
      actorId: userId,
      action: "AUTH.LOGOUT_ALL",
      entityId: userId,
      metadata: { revokedCount: count },
    });

    return { count };
  }

  /**
   * List active sessions for user (Tenant Scoped).
   */
  async getSessions(schoolId: string, userId: string, currentSessionId: string) {
    this.tenantContext.validateTenantId(schoolId);
    const sessions = await this.sessionRepository.getUserSessions(schoolId, userId);

    return sessions.map((s) => ({
      id: s.id,
      clientType: s.clientType,
      userAgent: s.userAgent,
      ipAddress: s.ipAddress,
      createdAt: s.createdAt.toISOString(),
      expiresAt: s.expiresAt.toISOString(),
      isCurrent: s.id === currentSessionId,
    }));
  }

  /**
   * Revoke a specific session by ID (Tenant Scoped).
   */
  async revokeSession(schoolId: string, userId: string, sessionId: string): Promise<void> {
    this.tenantContext.validateTenantId(schoolId);
    const revoked = await this.sessionRepository.revokeSessionById(schoolId, userId, sessionId);
    if (!revoked) {
      throw new NotFoundException("Session not found or already revoked");
    }

    await this.sessionRepository.recordAuditLog({
      schoolId,
      actorId: userId,
      action: "AUTH.SESSION_REVOKED",
      entityId: sessionId,
      metadata: { targetSessionId: sessionId },
    });
  }

  /**
   * Changes current user's password, validates policy, updates hash,
   * and revokes all other active sessions for that user.
   */
  async changePassword(
    schoolId: string,
    userId: string,
    currentSessionId: string,
    dto: ChangePasswordDto,
    meta: { userAgent?: string; ip: string },
  ) {
    this.tenantContext.validateTenantId(schoolId);
    const user = await this.sessionRepository.findUserById(schoolId, userId);
    if (!user || !user.isActive || !user.passwordHash) {
      throw new UnauthorizedException("User not found or inactive.");
    }

    const isCurrentValid = await this.passwordService.verify(
      user.passwordHash,
      dto.currentPassword,
    );
    if (!isCurrentValid) {
      throw new UnauthorizedException("Current password is incorrect.");
    }

    const policy = this.passwordService.validatePolicy(dto.newPassword);
    if (!policy.valid) {
      throw new BadRequestException(
        policy.message || "Password does not meet security requirements.",
      );
    }

    const strength = this.passwordService.evaluateStrength(dto.newPassword, [
      user.email,
      user.firstName,
      user.lastName,
    ]);
    if (strength.score < 3) {
      throw new BadRequestException("Password is too weak. Please choose a stronger password.");
    }

    const newHash = await this.passwordService.hash(dto.newPassword);
    await this.sessionRepository.updateUserPassword(schoolId, userId, newHash);
    const revokedCount = await this.sessionRepository.revokeOtherUserSessions(
      schoolId,
      userId,
      currentSessionId,
    );

    await this.sessionRepository.recordAuditLog({
      schoolId,
      actorId: userId,
      action: "AUTH.PASSWORD_CHANGED",
      entityId: userId,
      metadata: {
        revokedOtherSessionsCount: revokedCount,
        ipAddress: meta.ip,
        userAgent: meta.userAgent,
      },
    });

    return {
      message: "Password changed successfully. Other sessions have been revoked.",
      revokedOtherSessionsCount: revokedCount,
    };
  }

  /**
   * First login forced password change: takes temporary token with scope 'pwd_change_pending',
   * updates password, clears must_change_password flag, revokes any prior sessions,
   * and issues full authenticated session.
   */
  async firstLoginPassword(
    claims: { userId: string; schoolId: string; scope?: string },
    dto: FirstLoginPasswordDto,
    meta: { userAgent?: string; ip: string; clientType?: "web" | "mobile" },
  ) {
    if (claims.scope !== "pwd_change_pending" && claims.scope !== "access") {
      throw new ForbiddenException("Invalid token scope for password change");
    }

    const policy = this.passwordService.validatePolicy(dto.newPassword);
    if (!policy.valid) {
      throw new BadRequestException(
        policy.message || "Password does not meet security requirements.",
      );
    }

    const strength = this.passwordService.evaluateStrength(dto.newPassword);
    if (strength.score < 3) {
      throw new BadRequestException("Password is too weak. Please choose a stronger password.");
    }

    const schoolId = claims.schoolId;
    const userId = claims.userId;

    const user = await this.sessionRepository.findUserById(schoolId, userId);
    if (!user) {
      throw new UnauthorizedException("User not found.");
    }

    const newHash = await this.passwordService.hash(dto.newPassword);
    await this.sessionRepository.updateUserPassword(schoolId, userId, newHash);
    await this.sessionRepository.revokeAllUserSessions(schoolId, userId);

    const clientType = meta.clientType || "web";
    const rawRefreshToken = this.tokenService.generateRefreshToken();
    const tokenHash = this.tokenService.hashToken(rawRefreshToken);
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

    const session = await this.sessionRepository.createSession({
      schoolId,
      userId,
      tokenHash,
      clientType,
      userAgent: meta.userAgent,
      ipAddress: meta.ip,
      expiresAt,
    });

    const { token: accessToken, expiresIn } = await this.tokenService.createAccessToken({
      userId,
      schoolId,
      sessionId: session.id,
    });

    const compoundRefreshToken = this.tokenService.buildCompoundRefreshToken(
      schoolId,
      rawRefreshToken,
    );

    await this.sessionRepository.recordAuditLog({
      schoolId,
      actorId: userId,
      action: "AUTH.FIRST_LOGIN_PASSWORD_CHANGE",
      entityId: userId,
      metadata: {
        sessionId: session.id,
        ipHmac: hmacHash(meta.ip, this.hmacSecret),
      },
    });

    const roles = user.userRoles.map((ur) => ur.role.name);

    return {
      accessToken,
      expiresIn,
      compoundRefreshToken,
      user: {
        id: user.id,
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
        mustChangePassword: false,
        roles,
      },
    };
  }

  /**
   * Request password reset email: timing-safe, generic response preventing user enumeration.
   */
  async forgotPassword(dto: ForgotPasswordDto, meta: { ip: string; userAgent?: string }) {
    const slug = dto.schoolSlug.trim().toLowerCase();
    const email = dto.email.trim().toLowerCase();

    await this.abusePreventionService.checkForgotPasswordRateLimit(meta.ip, email);
    await this.abusePreventionService.recordForgotPasswordAttempt(meta.ip, email);

    const school = await this.sessionRepository.findSchoolBySlug(slug);
    if (!school) {
      await this.passwordService.verifyDummy("dummy-pwd");
      return {
        message: "If an account matches that email, a password reset link has been sent.",
      };
    }

    const user = await this.sessionRepository.findUserByEmail(school.id, email);
    if (!user || !user.isActive) {
      await this.passwordService.verifyDummy("dummy-pwd");
      return {
        message: "If an account matches that email, a password reset link has been sent.",
      };
    }

    const rawToken = this.tokenService.generateLifecycleToken();
    const tokenHash = this.tokenService.hashToken(rawToken);
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

    await this.sessionRepository.createPasswordResetToken({
      schoolId: school.id,
      userId: user.id,
      tokenHash,
      expiresAt,
      ipAddress: meta.ip,
      userAgent: meta.userAgent,
    });

    const compoundToken = this.tokenService.buildCompoundLifecycleToken(school.id, rawToken);

    await this.authEmailNotificationService.sendPasswordResetEmail(user.email, compoundToken);

    await this.sessionRepository.recordAuditLog({
      schoolId: school.id,
      actorId: user.id,
      action: "AUTH.PASSWORD_RESET_REQUESTED",
      entityId: user.id,
      metadata: {
        ipHmac: hmacHash(meta.ip, this.hmacSecret),
      },
    });

    return {
      message: "If an account matches that email, a password reset link has been sent.",
    };
  }

  /**
   * Reset password using compound token: validates token, enforces password strength,
   * updates password, revokes all user sessions, and NEVER logs the user in.
   */
  async resetPassword(dto: ResetPasswordDto, meta: { ip: string }) {
    await this.abusePreventionService.checkResetPasswordRateLimit(meta.ip);
    await this.abusePreventionService.recordResetPasswordAttempt(meta.ip);

    const { schoolId, rawToken } = this.tokenService.parseCompoundLifecycleToken(dto.token);
    const tokenHash = this.tokenService.hashToken(rawToken);

    const tokenRow = await this.sessionRepository.findPasswordResetToken(schoolId, tokenHash);
    if (!tokenRow) {
      throw new BadRequestException("Invalid or expired reset token.");
    }

    const policy = this.passwordService.validatePolicy(dto.newPassword);
    if (!policy.valid) {
      throw new BadRequestException(
        policy.message || "Password does not meet security requirements.",
      );
    }

    const strength = this.passwordService.evaluateStrength(dto.newPassword);
    if (strength.score < 3) {
      throw new BadRequestException("Password is too weak. Please choose a stronger password.");
    }

    // Mark token used immediately
    await this.sessionRepository.markPasswordResetTokenUsed(schoolId, tokenRow.id);

    // Hash new password and update user
    const newHash = await this.passwordService.hash(dto.newPassword);
    await this.sessionRepository.updateUserPassword(schoolId, tokenRow.userId, newHash);

    // Revoke all existing sessions for this user (Amendment 5)
    await this.sessionRepository.revokeAllUserSessions(schoolId, tokenRow.userId);

    await this.sessionRepository.recordAuditLog({
      schoolId,
      actorId: tokenRow.userId,
      action: "AUTH.PASSWORD_RESET_SUCCESS",
      entityId: tokenRow.userId,
      metadata: {
        ipHmac: hmacHash(meta.ip, this.hmacSecret),
      },
    });

    return {
      message: "Password has been successfully reset. Please log in with your new password.",
    };
  }

  /**
   * Verify email using compound token.
   */
  async verifyEmail(dto: VerifyEmailDto) {
    const { schoolId, rawToken } = this.tokenService.parseCompoundLifecycleToken(dto.token);
    const tokenHash = this.tokenService.hashToken(rawToken);

    const tokenRow = await this.sessionRepository.findEmailVerificationToken(schoolId, tokenHash);
    if (!tokenRow) {
      throw new BadRequestException("Invalid or expired verification token.");
    }

    await this.sessionRepository.markEmailVerified(schoolId, tokenRow.id, tokenRow.userId);

    await this.sessionRepository.recordAuditLog({
      schoolId,
      actorId: tokenRow.userId,
      action: "AUTH.EMAIL_VERIFIED",
      entityId: tokenRow.userId,
    });

    return {
      message: "Email has been successfully verified.",
    };
  }

  /**
   * Resend email verification link: generic response preventing user enumeration.
   */
  async resendVerification(dto: ResendVerificationDto, meta: { ip: string }) {
    const slug = dto.schoolSlug.trim().toLowerCase();
    const email = dto.email.trim().toLowerCase();

    await this.abusePreventionService.checkResendVerificationRateLimit(meta.ip, email);
    await this.abusePreventionService.recordResendVerificationAttempt(meta.ip, email);

    const school = await this.sessionRepository.findSchoolBySlug(slug);
    if (!school) {
      return {
        message: "If an account matches that email, a verification link has been sent.",
      };
    }

    const user = await this.sessionRepository.findUserByEmail(school.id, email);
    if (!user || !user.isActive || user.emailVerifiedAt) {
      return {
        message: "If an account matches that email, a verification link has been sent.",
      };
    }

    const rawToken = this.tokenService.generateLifecycleToken();
    const tokenHash = this.tokenService.hashToken(rawToken);
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hours

    await this.sessionRepository.createEmailVerificationToken({
      schoolId: school.id,
      userId: user.id,
      tokenHash,
      expiresAt,
    });

    const compoundToken = this.tokenService.buildCompoundLifecycleToken(school.id, rawToken);

    await this.authEmailNotificationService.sendEmailVerificationEmail(user.email, compoundToken);

    return {
      message: "If an account matches that email, a verification link has been sent.",
    };
  }

  /**
   * Returns current authenticated user profile.
   */
  async getMe(schoolId: string, userId: string) {
    this.tenantContext.validateTenantId(schoolId);
    const user = await this.sessionRepository.findUserById(schoolId, userId);
    if (!user) {
      throw new NotFoundException("User not found");
    }
    const roles = user.userRoles.map((ur) => ur.role.name);
    return {
      id: user.id,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      mustChangePassword: user.mustChangePassword,
      roles,
      isTwoFactorEnabled: user.isTwoFactorEnabled,
    };
  }

  /**
   * Generates a new TOTP secret for the authenticated user and stores it in pending state.
   */
  async setup2Fa(schoolId: string, userId: string) {
    this.tenantContext.validateTenantId(schoolId);
    const user = await this.sessionRepository.findUserById(schoolId, userId);
    if (!user) {
      throw new UnauthorizedException("User not found.");
    }

    const school = await this.sessionRepository.findSchoolById(schoolId);
    const secret = this.totpService.generateSecret();
    const { encryptedSecret, iv, authTag } = this.totpService.encryptSecret(secret);

    await this.sessionRepository.upsertTwoFactorSecret({
      schoolId,
      userId,
      encryptedSecret,
      iv,
      authTag,
    });

    const uri = this.totpService.generateOtpAuthUri(
      secret,
      user.email,
      school?.name ?? "ProgressEye",
    );

    return { secret, uri };
  }

  /**
   * Verifies the initial TOTP code to confirm the authenticator app and enables 2FA.
   * Generates 8 single-use recovery codes and returns them once to the user.
   * If invoked during 2fa_setup_pending flow, issues a full authenticated session.
   */
  async enable2Fa(
    schoolId: string,
    userId: string,
    code: string,
    meta?: {
      clientIp: string;
      userAgent?: string;
      isMobile: boolean;
      isSetupPending?: boolean;
    },
  ) {
    this.tenantContext.validateTenantId(schoolId);
    const secretRecord = await this.sessionRepository.findTwoFactorSecret(schoolId, userId);
    if (!secretRecord) {
      throw new BadRequestException("Two-factor authentication setup has not been initiated.");
    }

    const plainSecret = this.totpService.decryptSecret(
      secretRecord.encryptedSecret,
      secretRecord.iv,
      secretRecord.authTag,
    );
    if (!plainSecret) {
      throw new BadRequestException("Invalid two-factor secret configuration.");
    }

    const matched = this.totpService.verifyCodeWithoutReplay(plainSecret, code);
    if (matched === null) {
      throw new BadRequestException("Invalid verification code.");
    }

    const { plainCodes, hashedCodes } = this.totpService.generateRecoveryCodes();

    await this.sessionRepository.enableTwoFactor({
      schoolId,
      userId,
      recoveryCodeHashes: hashedCodes,
    });

    this.logger.log({
      event: "tenant_audit",
      action: "AUTH.2FA_ENABLED",
      schoolId,
      userId,
    });

    if (meta?.isSetupPending) {
      const user = await this.sessionRepository.findUserById(schoolId, userId);
      if (user && user.isActive) {
        const rawRefreshToken = this.tokenService.generateRefreshToken();
        const tokenHash = this.tokenService.hashToken(rawRefreshToken);
        const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

        const session = await this.sessionRepository.createSession({
          schoolId,
          userId: user.id,
          tokenHash,
          clientType: meta.isMobile ? "mobile" : "web",
          userAgent: meta.userAgent,
          ipAddress: meta.clientIp,
          expiresAt,
        });

        const { token: accessToken, expiresIn } = await this.tokenService.createAccessToken({
          userId: user.id,
          schoolId,
          sessionId: session.id,
        });

        const compoundRefreshToken = this.tokenService.buildCompoundRefreshToken(
          schoolId,
          rawRefreshToken,
        );

        return {
          recoveryCodes: plainCodes,
          accessToken,
          expiresIn,
          tokenType: "Bearer",
          compoundRefreshToken,
          refreshToken: meta.isMobile ? compoundRefreshToken : undefined,
          user: {
            id: user.id,
            email: user.email,
            firstName: user.firstName,
            lastName: user.lastName,
            roles: user.userRoles.map((ur) => ur.role.name),
            isTwoFactorEnabled: true,
          },
        };
      }
    }

    return { recoveryCodes: plainCodes };
  }

  /**
   * Verifies a 6-digit TOTP code during login using a temporary 2fa_pending token.
   * Enforces replay prevention via Redis and per-user shared attempt cap.
   * Returns generic 401 error on any verification failure.
   */
  async verify2Fa(
    dto: TotpVerifyDto,
    meta: { ip: string; userAgent?: string; clientType?: string },
  ) {
    let claims: { sub: string; schoolId: string; scope?: string };
    try {
      claims = await this.tokenService.verifyAccessToken(dto.temporaryToken);
    } catch {
      throw new UnauthorizedException("Invalid two-factor authentication credentials.");
    }

    if (claims.scope !== "2fa_pending") {
      throw new UnauthorizedException("Invalid two-factor authentication credentials.");
    }

    // Shared per-user attempt cap between TOTP and recovery codes (max 5 in 15 min)
    const withinCap = await this.totpService.checkAndIncrementAttemptCap(claims.sub);
    if (!withinCap) {
      this.logger.warn({
        event: "platform_audit",
        action: "AUTH.2FA_ATTEMPT_CAP_EXCEEDED",
        userId: claims.sub,
        schoolId: claims.schoolId,
      });
      throw new UnauthorizedException("Invalid two-factor authentication credentials.");
    }

    const secretRecord = await this.sessionRepository.findTwoFactorSecret(
      claims.schoolId,
      claims.sub,
    );
    if (!secretRecord || !secretRecord.isVerified) {
      throw new UnauthorizedException("Invalid two-factor authentication credentials.");
    }

    const plainSecret = this.totpService.decryptSecret(
      secretRecord.encryptedSecret,
      secretRecord.iv,
      secretRecord.authTag,
    );
    if (!plainSecret) {
      throw new UnauthorizedException("Invalid two-factor authentication credentials.");
    }

    const isValid = await this.totpService.verifyTotpCode(claims.sub, plainSecret, dto.code);
    if (!isValid) {
      throw new UnauthorizedException("Invalid two-factor authentication credentials.");
    }

    // Reset attempt cap on success
    await this.totpService.resetAttemptCap(claims.sub);

    const user = await this.sessionRepository.findUserById(claims.schoolId, claims.sub);
    if (!user || !user.isActive) {
      throw new UnauthorizedException("Invalid two-factor authentication credentials.");
    }

    const roles = user.userRoles.map((ur) => ur.role.name);

    if (user.mustChangePassword) {
      const { token: temporaryToken, expiresIn: tempExpiresIn } =
        await this.tokenService.createTemporaryPasswordChangeToken({
          userId: user.id,
          schoolId: claims.schoolId,
        });

      return {
        mustChangePassword: true,
        temporaryToken,
        expiresIn: tempExpiresIn,
        user: {
          id: user.id,
          email: user.email,
          firstName: user.firstName,
          lastName: user.lastName,
          mustChangePassword: true,
          roles,
          isTwoFactorEnabled: true,
        },
      };
    }

    const rawRefreshToken = this.tokenService.generateRefreshToken();
    const tokenHash = this.tokenService.hashToken(rawRefreshToken);
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

    const session = await this.sessionRepository.createSession({
      schoolId: claims.schoolId,
      userId: user.id,
      tokenHash,
      clientType: meta.clientType ?? "web",
      userAgent: meta.userAgent,
      ipAddress: meta.ip,
      expiresAt,
    });

    const { token: accessToken, expiresIn } = await this.tokenService.createAccessToken({
      userId: user.id,
      schoolId: claims.schoolId,
      sessionId: session.id,
    });

    const compoundRefreshToken = this.tokenService.buildCompoundRefreshToken(
      claims.schoolId,
      rawRefreshToken,
    );

    await this.sessionRepository.recordAuditLog({
      schoolId: claims.schoolId,
      actorId: user.id,
      action: "AUTH.2FA_LOGIN_SUCCESS",
      entityId: user.id,
      metadata: {
        sessionId: session.id,
        method: "totp",
        ipHmac: hmacHash(meta.ip, this.hmacSecret),
      },
    });

    return {
      accessToken,
      expiresIn,
      compoundRefreshToken,
      user: {
        id: user.id,
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
        mustChangePassword: user.mustChangePassword,
        roles,
        isTwoFactorEnabled: true,
      },
    };
  }

  /**
   * Verifies a single-use recovery code during login using a temporary 2fa_pending token.
   * Returns generic 401 error on any verification failure.
   */
  async verifyRecoveryCode(
    dto: RecoveryCodeVerifyDto,
    meta: { ip: string; userAgent?: string; clientType?: string },
  ) {
    let claims: { sub: string; schoolId: string; scope?: string };
    try {
      claims = await this.tokenService.verifyAccessToken(dto.temporaryToken);
    } catch {
      throw new UnauthorizedException("Invalid two-factor authentication credentials.");
    }

    if (claims.scope !== "2fa_pending") {
      throw new UnauthorizedException("Invalid two-factor authentication credentials.");
    }

    const withinCap = await this.totpService.checkAndIncrementAttemptCap(claims.sub);
    if (!withinCap) {
      this.logger.warn({
        event: "platform_audit",
        action: "AUTH.2FA_ATTEMPT_CAP_EXCEEDED",
        userId: claims.sub,
        schoolId: claims.schoolId,
      });
      throw new UnauthorizedException("Invalid two-factor authentication credentials.");
    }

    const codeHash = this.totpService.hashRecoveryCode(dto.recoveryCode);
    const consumed = await this.sessionRepository.verifyAndConsumeRecoveryCode({
      schoolId: claims.schoolId,
      userId: claims.sub,
      codeHash,
    });

    if (!consumed) {
      throw new UnauthorizedException("Invalid two-factor authentication credentials.");
    }

    await this.totpService.resetAttemptCap(claims.sub);

    const user = await this.sessionRepository.findUserById(claims.schoolId, claims.sub);
    if (!user || !user.isActive) {
      throw new UnauthorizedException("Invalid two-factor authentication credentials.");
    }

    const roles = user.userRoles.map((ur) => ur.role.name);

    if (user.mustChangePassword) {
      const { token: temporaryToken, expiresIn: tempExpiresIn } =
        await this.tokenService.createTemporaryPasswordChangeToken({
          userId: user.id,
          schoolId: claims.schoolId,
        });

      return {
        mustChangePassword: true,
        temporaryToken,
        expiresIn: tempExpiresIn,
        user: {
          id: user.id,
          email: user.email,
          firstName: user.firstName,
          lastName: user.lastName,
          mustChangePassword: true,
          roles,
          isTwoFactorEnabled: true,
        },
      };
    }

    const rawRefreshToken = this.tokenService.generateRefreshToken();
    const tokenHash = this.tokenService.hashToken(rawRefreshToken);
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

    const session = await this.sessionRepository.createSession({
      schoolId: claims.schoolId,
      userId: user.id,
      tokenHash,
      clientType: meta.clientType ?? "web",
      userAgent: meta.userAgent,
      ipAddress: meta.ip,
      expiresAt,
    });

    const { token: accessToken, expiresIn } = await this.tokenService.createAccessToken({
      userId: user.id,
      schoolId: claims.schoolId,
      sessionId: session.id,
    });

    const compoundRefreshToken = this.tokenService.buildCompoundRefreshToken(
      claims.schoolId,
      rawRefreshToken,
    );

    await this.sessionRepository.recordAuditLog({
      schoolId: claims.schoolId,
      actorId: user.id,
      action: "AUTH.2FA_RECOVERY_SUCCESS",
      entityId: user.id,
      metadata: {
        sessionId: session.id,
        method: "recovery_code",
        ipHmac: hmacHash(meta.ip, this.hmacSecret),
      },
    });

    return {
      accessToken,
      expiresIn,
      compoundRefreshToken,
      user: {
        id: user.id,
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
        mustChangePassword: user.mustChangePassword,
        roles,
        isTwoFactorEnabled: true,
      },
    };
  }

  /**
   * Disables 2FA after verifying current user password and valid TOTP code.
   * Revokes 2FA secret, recovery codes, and revokes other active sessions.
   */
  async disable2Fa(schoolId: string, userId: string, currentSessionId: string, dto: Disable2FaDto) {
    this.tenantContext.validateTenantId(schoolId);
    const user = await this.sessionRepository.findUserById(schoolId, userId);
    if (!user || !user.passwordHash) {
      throw new UnauthorizedException("User not found.");
    }

    const isPasswordValid = await this.passwordService.verify(user.passwordHash, dto.password);
    if (!isPasswordValid) {
      throw new UnauthorizedException("Current password is incorrect.");
    }

    const secretRecord = await this.sessionRepository.findTwoFactorSecret(schoolId, userId);
    if (!secretRecord || !secretRecord.isVerified) {
      throw new BadRequestException("Two-factor authentication is not active.");
    }

    const plainSecret = this.totpService.decryptSecret(
      secretRecord.encryptedSecret,
      secretRecord.iv,
      secretRecord.authTag,
    );
    if (!plainSecret) {
      throw new BadRequestException("Invalid two-factor secret configuration.");
    }

    const matched = this.totpService.verifyCodeWithoutReplay(plainSecret, dto.code);
    if (matched === null) {
      throw new BadRequestException("Invalid verification code.");
    }

    await this.sessionRepository.disableTwoFactor(schoolId, userId, currentSessionId);

    this.logger.log({
      event: "tenant_audit",
      action: "AUTH.2FA_DISABLED",
      schoolId,
      userId,
    });

    return { message: "Two-factor authentication disabled successfully." };
  }

  /**
   * Regenerates recovery codes: requires password re-authentication and active 2FA.
   * Revokes existing recovery codes and revokes other sessions.
   */
  async regenerateRecoveryCodes(
    schoolId: string,
    userId: string,
    currentSessionId: string,
    dto: RegenerateRecoveryCodesDto,
  ) {
    this.tenantContext.validateTenantId(schoolId);
    const user = await this.sessionRepository.findUserById(schoolId, userId);
    if (!user || !user.passwordHash) {
      throw new UnauthorizedException("User not found.");
    }

    if (!user.isTwoFactorEnabled) {
      throw new BadRequestException(
        "Two-factor authentication must be enabled to regenerate recovery codes.",
      );
    }

    const isPasswordValid = await this.passwordService.verify(user.passwordHash, dto.password);
    if (!isPasswordValid) {
      throw new UnauthorizedException("Current password is incorrect.");
    }

    const { plainCodes, hashedCodes } = this.totpService.generateRecoveryCodes();

    await this.sessionRepository.regenerateRecoveryCodes({
      schoolId,
      userId,
      recoveryCodeHashes: hashedCodes,
      currentSessionId,
    });

    this.logger.log({
      event: "tenant_audit",
      action: "AUTH.RECOVERY_CODES_REGENERATED",
      schoolId,
      userId,
    });

    return { recoveryCodes: plainCodes };
  }

  /**
   * SMS OTP Stub: masks telephone number and logs dispatch intent.
   * Does NOT store telephone number or OTP in database or logs, and does not contact external providers.
   */
  sendSmsOtp(dto: SmsOtpDto) {
    const cleanPhone = dto.phoneNumber.trim();
    const visibleSuffix = cleanPhone.slice(-4);
    const prefix = cleanPhone.slice(0, Math.max(0, cleanPhone.length - 8));
    const maskedPhone = `${prefix}***-***-${visibleSuffix}`;

    this.logger.log({
      event: "platform_audit",
      action: "AUTH.SMS_OTP_REQUESTED",
      schoolSlug: dto.schoolSlug,
      maskedPhone,
      message: `[SMS Stub] OTP dispatch requested for phone ${maskedPhone} (schoolSlug: ${dto.schoolSlug}) - provider contact suppressed in stub mode`,
    });

    return {
      message:
        "If this account is eligible for SMS verification, a one-time code has been dispatched.",
    };
  }

  /**
   * Evaluates password strength via zxcvbn.
   */
  evaluatePasswordStrength(password: string, userInputs: string[] = []) {
    return this.passwordService.evaluateStrength(password, userInputs);
  }
}
