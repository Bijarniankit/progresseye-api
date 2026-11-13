import { BadRequestException, Injectable, Logger, UnauthorizedException } from "@nestjs/common";
import { SYSTEM_TENANT_ID } from "../../../common/request-context/tenant-context.service";
import { normalizeEmail } from "../../../common/utils/sanitization";
import { PrismaService } from "../../../infra/prisma/prisma.service";
import { AbusePreventionService } from "../../identity/domain/abuse-prevention.service";
import { PasswordService } from "../../identity/domain/password.service";
import { TokenService } from "../../identity/domain/token.service";
import { TotpService } from "../../identity/domain/totp.service";
import { SessionRepository } from "../../identity/infra/session.repository";
import type {
  Platform2FaEnableDto,
  Platform2FaVerifyDto,
  PlatformLoginDto,
} from "../dto/platform-auth.dto";
import { PlatformAuditService } from "./platform-audit.service";

@Injectable()
export class PlatformAuthService {
  private readonly logger = new Logger(PlatformAuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly passwordService: PasswordService,
    private readonly tokenService: TokenService,
    private readonly totpService: TotpService,
    private readonly sessionRepository: SessionRepository,
    private readonly platformAuditService: PlatformAuditService,
    private readonly abusePreventionService: AbusePreventionService,
  ) {}

  /**
   * First step of platform authentication: verifies email + password.
   * Never returns an access token; 2FA is mandatory for all platform admins.
   * Returns temporary token with platform_2fa_pending or platform_2fa_setup_pending scope.
   */
  async login(dto: PlatformLoginDto, meta: { ip: string; userAgent?: string }) {
    const email = normalizeEmail(dto.email);

    await this.abusePreventionService.checkPreLogin(meta.ip, email, SYSTEM_TENANT_ID);

    const user = await this.prisma.withTenant(SYSTEM_TENANT_ID, async (tx) => {
      return tx.user.findFirst({
        where: {
          email,
          schoolId: SYSTEM_TENANT_ID,
          deletedAt: null,
        },
        include: {
          userRoles: {
            include: {
              role: true,
            },
          },
        },
      });
    });

    if (!user || !user.isActive || !user.passwordHash) {
      await this.abusePreventionService.recordFailedLogin(meta.ip, email, SYSTEM_TENANT_ID);
      await this.passwordService.verify(
        "$argon2id$v=19$m=65536,t=3,p=4$dummyhashdummyhashdummyhash$dummyhashdummyhashdummyhash",
        dto.password,
      );
      await this.platformAuditService.recordEvent({
        action: "PLATFORM_LOGIN_FAILURE",
        resource: "user",
        payload: { emailDomain: email.split("@")[1], reason: "User not found or inactive" },
        clientIp: meta.ip,
        userAgent: meta.userAgent,
      });
      throw new UnauthorizedException("Invalid platform credentials.");
    }

    const isValidPassword = await this.passwordService.verify(user.passwordHash, dto.password);
    if (!isValidPassword) {
      await this.abusePreventionService.recordFailedLogin(meta.ip, email, SYSTEM_TENANT_ID);
      await this.platformAuditService.recordEvent({
        actorUserId: user.id,
        action: "PLATFORM_LOGIN_FAILURE",
        resource: "user",
        resourceId: user.id,
        payload: { reason: "Invalid password" },
        clientIp: meta.ip,
        userAgent: meta.userAgent,
      });
      throw new UnauthorizedException("Invalid platform credentials.");
    }

    const hasPlatformAdminRole = user.userRoles.some((ur) => ur.role.slug === "platform_admin");
    if (!hasPlatformAdminRole) {
      await this.abusePreventionService.recordFailedLogin(meta.ip, email, SYSTEM_TENANT_ID);
      await this.platformAuditService.recordEvent({
        actorUserId: user.id,
        action: "PLATFORM_LOGIN_FAILURE",
        resource: "user",
        resourceId: user.id,
        payload: { reason: "Missing platform_admin role" },
        clientIp: meta.ip,
        userAgent: meta.userAgent,
      });
      throw new UnauthorizedException("Invalid platform credentials.");
    }

    if (user.isTwoFactorEnabled) {
      const { token: temporaryToken, expiresIn } =
        await this.tokenService.createTemporaryPlatformTwoFactorToken({
          userId: user.id,
          setup: false,
        });

      await this.platformAuditService.recordEvent({
        actorUserId: user.id,
        action: "PLATFORM_LOGIN_CHALLENGE",
        resource: "user",
        resourceId: user.id,
        payload: { scope: "platform_2fa_pending" },
        clientIp: meta.ip,
        userAgent: meta.userAgent,
      });

      return {
        requires2Fa: true,
        scope: "platform_2fa_pending",
        temporaryToken,
        expiresIn,
      };
    }

    const { token: temporaryToken, expiresIn } =
      await this.tokenService.createTemporaryPlatformTwoFactorToken({
        userId: user.id,
        setup: true,
      });

    await this.platformAuditService.recordEvent({
      actorUserId: user.id,
      action: "PLATFORM_LOGIN_SETUP_CHALLENGE",
      resource: "user",
      resourceId: user.id,
      payload: { scope: "platform_2fa_setup_pending" },
      clientIp: meta.ip,
      userAgent: meta.userAgent,
    });

    return {
      requires2Fa: true,
      scope: "platform_2fa_setup_pending",
      temporaryToken,
      expiresIn,
    };
  }

  /**
   * Initializes 2FA setup for a platform administrator holding platform_2fa_setup_pending token.
   */
  async setup2Fa(token: string) {
    const claims = await this.tokenService.verifyAccessToken(token);
    if (claims.schoolId !== SYSTEM_TENANT_ID || claims.scope !== "platform_2fa_setup_pending") {
      throw new UnauthorizedException("Invalid platform 2FA setup credentials.");
    }

    const user = await this.prisma.withTenant(SYSTEM_TENANT_ID, async (tx) => {
      return tx.user.findFirst({
        where: { id: claims.sub, schoolId: SYSTEM_TENANT_ID, deletedAt: null },
      });
    });
    if (!user || !user.isActive) {
      throw new UnauthorizedException("Invalid platform 2FA setup credentials.");
    }

    const { secret, uri } = this.totpService.generateTotpSetup(user.email, "ProgressEye Platform");
    const { encryptedSecret, iv, authTag } = this.totpService.encryptSecret(secret);

    await this.sessionRepository.upsertTwoFactorSecret({
      schoolId: SYSTEM_TENANT_ID,
      userId: user.id,
      encryptedSecret,
      iv,
      authTag,
    });

    return { secret, uri };
  }

  /**
   * Completes initial 2FA enrollment for a platform administrator and issues a full platform session.
   */
  async enable2Fa(
    token: string,
    dto: Platform2FaEnableDto,
    meta: { ip: string; userAgent?: string },
  ) {
    const claims = await this.tokenService.verifyAccessToken(token);
    if (claims.schoolId !== SYSTEM_TENANT_ID || claims.scope !== "platform_2fa_setup_pending") {
      throw new UnauthorizedException("Invalid platform 2FA setup credentials.");
    }

    const secretRecord = await this.sessionRepository.findTwoFactorSecret(
      SYSTEM_TENANT_ID,
      claims.sub,
    );
    if (!secretRecord) {
      throw new BadRequestException(
        "Platform two-factor authentication setup has not been initiated.",
      );
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

    const { plainCodes, hashedCodes } = this.totpService.generateRecoveryCodes();

    await this.sessionRepository.enableTwoFactor({
      schoolId: SYSTEM_TENANT_ID,
      userId: claims.sub,
      recoveryCodeHashes: hashedCodes,
    });

    const user = await this.prisma.withTenant(SYSTEM_TENANT_ID, async (tx) => {
      return tx.user.findFirst({
        where: { id: claims.sub, schoolId: SYSTEM_TENANT_ID },
      });
    });

    if (!user || !user.isActive) {
      throw new UnauthorizedException("User not found or inactive.");
    }

    const rawRefreshToken = this.tokenService.generateRefreshToken();
    const tokenHash = this.tokenService.hashToken(rawRefreshToken);
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

    const session = await this.sessionRepository.createSession({
      schoolId: SYSTEM_TENANT_ID,
      userId: user.id,
      tokenHash,
      clientType: "web",
      userAgent: meta.userAgent,
      ipAddress: meta.ip,
      expiresAt,
    });

    const { token: accessToken, expiresIn } = await this.tokenService.createPlatformAccessToken({
      userId: user.id,
      sessionId: session.id,
    });

    await this.abusePreventionService.recordSuccessfulLogin(meta.ip, user.email, SYSTEM_TENANT_ID);

    await this.platformAuditService.recordEvent({
      actorUserId: user.id,
      action: "PLATFORM_2FA_ENABLED",
      resource: "user",
      resourceId: user.id,
      payload: { userId: user.id },
      clientIp: meta.ip,
      userAgent: meta.userAgent,
    });

    await this.platformAuditService.recordEvent({
      actorUserId: user.id,
      action: "PLATFORM_LOGIN_SUCCESS",
      resource: "session",
      resourceId: session.id,
      payload: { sessionId: session.id },
      clientIp: meta.ip,
      userAgent: meta.userAgent,
    });

    return {
      accessToken,
      expiresIn,
      tokenType: "Bearer",
      recoveryCodes: plainCodes,
      user: {
        id: user.id,
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
      },
    };
  }

  /**
   * Verifies 2FA challenge code (TOTP or recovery code) during platform login.
   */
  async verify2Fa(
    token: string,
    dto: Platform2FaVerifyDto,
    meta: { ip: string; userAgent?: string },
  ) {
    const claims = await this.tokenService.verifyAccessToken(token);
    if (claims.schoolId !== SYSTEM_TENANT_ID || claims.scope !== "platform_2fa_pending") {
      throw new UnauthorizedException("Invalid platform 2FA credentials.");
    }

    const withinCap = await this.totpService.checkAndIncrementAttemptCap(claims.sub);
    if (!withinCap) {
      await this.platformAuditService.recordEvent({
        actorUserId: claims.sub,
        action: "PLATFORM_2FA_ATTEMPT_CAP_EXCEEDED",
        resource: "user",
        resourceId: claims.sub,
        clientIp: meta.ip,
        userAgent: meta.userAgent,
      });
      throw new UnauthorizedException("Too many failed attempts. Try again later.");
    }

    const secretRecord = await this.sessionRepository.findTwoFactorSecret(
      SYSTEM_TENANT_ID,
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
      throw new UnauthorizedException("Invalid two-factor secret configuration.");
    }

    let isValid = false;
    if (dto.code.length === 6 && /^\d{6}$/.test(dto.code)) {
      isValid = await this.totpService.verifyTotpCode(claims.sub, plainSecret, dto.code);
    }

    if (!isValid) {
      const codeHash = this.totpService.hashRecoveryCode(dto.code);
      const consumed = await this.sessionRepository.verifyAndConsumeRecoveryCode({
        schoolId: SYSTEM_TENANT_ID,
        userId: claims.sub,
        codeHash,
      });
      if (consumed) {
        isValid = true;
        await this.platformAuditService.recordEvent({
          actorUserId: claims.sub,
          action: "PLATFORM_2FA_RECOVERY_CODE_CONSUMED",
          resource: "user",
          resourceId: claims.sub,
          clientIp: meta.ip,
          userAgent: meta.userAgent,
        });
      }
    }

    if (!isValid) {
      await this.abusePreventionService.recordFailedLogin(meta.ip, claims.sub, SYSTEM_TENANT_ID);
      await this.platformAuditService.recordEvent({
        actorUserId: claims.sub,
        action: "PLATFORM_2FA_VERIFY_FAILURE",
        resource: "user",
        resourceId: claims.sub,
        clientIp: meta.ip,
        userAgent: meta.userAgent,
      });
      throw new UnauthorizedException("Invalid two-factor authentication code.");
    }

    await this.totpService.resetAttemptCap(claims.sub);

    const user = await this.prisma.withTenant(SYSTEM_TENANT_ID, async (tx) => {
      return tx.user.findFirst({
        where: { id: claims.sub, schoolId: SYSTEM_TENANT_ID },
      });
    });
    if (!user || !user.isActive) {
      throw new UnauthorizedException("Invalid user status.");
    }

    const rawRefreshToken = this.tokenService.generateRefreshToken();
    const tokenHash = this.tokenService.hashToken(rawRefreshToken);
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

    const session = await this.sessionRepository.createSession({
      schoolId: SYSTEM_TENANT_ID,
      userId: user.id,
      tokenHash,
      clientType: "web",
      userAgent: meta.userAgent,
      ipAddress: meta.ip,
      expiresAt,
    });

    const { token: accessToken, expiresIn } = await this.tokenService.createPlatformAccessToken({
      userId: user.id,
      sessionId: session.id,
    });

    await this.abusePreventionService.recordSuccessfulLogin(meta.ip, user.email, SYSTEM_TENANT_ID);

    await this.platformAuditService.recordEvent({
      actorUserId: user.id,
      action: "PLATFORM_LOGIN_SUCCESS",
      resource: "session",
      resourceId: session.id,
      payload: { sessionId: session.id },
      clientIp: meta.ip,
      userAgent: meta.userAgent,
    });

    return {
      accessToken,
      expiresIn,
      tokenType: "Bearer",
      user: {
        id: user.id,
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
      },
    };
  }
}
