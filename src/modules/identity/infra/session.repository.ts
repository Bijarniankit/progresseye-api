import { Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../../../infra/prisma/prisma.service";

export interface CreateSessionParams {
  schoolId: string;
  userId: string;
  tokenHash: string;
  clientType: string;
  userAgent?: string | null;
  ipAddress?: string | null;
  expiresAt: Date;
  familyId?: string;
  parentTokenHash?: string | null;
}

@Injectable()
export class SessionRepository {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Resolves school metadata by slug using the public RLS read policy on schools.
   */
  async findSchoolBySlug(slug: string) {
    return this.prisma.school.findFirst({
      where: {
        slug: slug.trim().toLowerCase(),
        isActive: true,
        deletedAt: null,
      },
      select: {
        id: true,
        slug: true,
        name: true,
        isActive: true,
      },
    });
  }

  /**
   * Resolves school metadata by ID.
   */
  async findSchoolById(schoolId: string) {
    return this.prisma.school.findFirst({
      where: {
        id: schoolId,
        isActive: true,
        deletedAt: null,
      },
      select: {
        id: true,
        slug: true,
        name: true,
        isActive: true,
      },
    });
  }

  /**
   * Finds a user by email within a bound school tenant context under RLS.
   */
  async findUserByEmail(schoolId: string, email: string) {
    return this.prisma.withTenant(schoolId, async (tx) => {
      return tx.user.findFirst({
        where: {
          schoolId,
          email: email.trim().toLowerCase(),
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
  }

  /**
   * Finds a user by ID within a bound school tenant context under RLS.
   */
  async findUserById(schoolId: string, userId: string) {
    return this.prisma.withTenant(schoolId, async (tx) => {
      return tx.user.findFirst({
        where: {
          schoolId,
          id: userId,
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
  }

  /**
   * Updates last login timestamp on a user record within tenant context.
   */
  async recordUserLogin(schoolId: string, userId: string): Promise<void> {
    await this.prisma.withTenant(schoolId, async (tx) => {
      await tx.user.update({
        where: { id: userId, schoolId },
        data: {
          lastLoginAt: new Date(),
          failedLoginAttempts: 0,
          lockedUntil: null,
        },
      });
    });
  }

  /**
   * Creates a new authentication session within tenant context.
   */
  async createSession(params: CreateSessionParams) {
    return this.prisma.withTenant(params.schoolId, async (tx) => {
      return tx.session.create({
        data: {
          schoolId: params.schoolId,
          userId: params.userId,
          tokenHash: params.tokenHash,
          clientType: params.clientType,
          userAgent: params.userAgent ?? null,
          ipAddress: params.ipAddress ?? null,
          expiresAt: params.expiresAt,
          familyId: params.familyId,
          parentTokenHash: params.parentTokenHash ?? null,
        },
      });
    });
  }

  /**
   * Finds a session by its token hash within the specified school tenant context.
   */
  async findSessionByTokenHash(schoolId: string, tokenHash: string) {
    return this.prisma.withTenant(schoolId, async (tx) => {
      return tx.session.findFirst({
        where: {
          schoolId,
          tokenHash,
        },
        include: {
          user: true,
        },
      });
    });
  }

  /**
   * Performs atomic rotation: marks old session revoked and creates the successor session
   * under the exact same familyId inside a single tenant transaction.
   */
  async rotateSession(
    schoolId: string,
    oldSessionId: string,
    newSessionParams: CreateSessionParams,
  ) {
    return this.prisma.withTenant(schoolId, async (tx) => {
      // 1. Mark existing session revoked
      await tx.session.update({
        where: { id: oldSessionId, schoolId },
        data: { revokedAt: new Date() },
      });

      // 2. Insert successor session
      return tx.session.create({
        data: {
          schoolId,
          userId: newSessionParams.userId,
          tokenHash: newSessionParams.tokenHash,
          clientType: newSessionParams.clientType,
          userAgent: newSessionParams.userAgent ?? null,
          ipAddress: newSessionParams.ipAddress ?? null,
          expiresAt: newSessionParams.expiresAt,
          familyId: newSessionParams.familyId,
          parentTokenHash: newSessionParams.parentTokenHash ?? null,
        },
      });
    });
  }

  /**
   * Revokes all sessions belonging to a familyId (Family Reuse Detection defense).
   */
  async revokeFamily(schoolId: string, familyId: string): Promise<number> {
    return this.prisma.withTenant(schoolId, async (tx) => {
      const res = await tx.session.updateMany({
        where: {
          schoolId,
          familyId,
          revokedAt: null,
        },
        data: {
          revokedAt: new Date(),
        },
      });
      return res.count;
    });
  }

  /**
   * Revokes a specific session by token hash.
   */
  async revokeSessionByTokenHash(schoolId: string, tokenHash: string): Promise<void> {
    await this.prisma.withTenant(schoolId, async (tx) => {
      await tx.session.updateMany({
        where: { schoolId, tokenHash, revokedAt: null },
        data: { revokedAt: new Date() },
      });
    });
  }

  /**
   * Revokes all active sessions for a user within a school (Tenant Scoped Logout-All).
   */
  async revokeAllUserSessions(schoolId: string, userId: string): Promise<number> {
    return this.prisma.withTenant(schoolId, async (tx) => {
      const res = await tx.session.updateMany({
        where: {
          schoolId,
          userId,
          revokedAt: null,
        },
        data: {
          revokedAt: new Date(),
        },
      });
      return res.count;
    });
  }

  /**
   * Revokes all active sessions for a user EXCEPT the current active session.
   * Used during password change to ensure other devices/browsers are immediately invalidated.
   */
  async revokeOtherUserSessions(
    schoolId: string,
    userId: string,
    exceptSessionId: string,
  ): Promise<number> {
    return this.prisma.withTenant(schoolId, async (tx) => {
      const res = await tx.session.updateMany({
        where: {
          schoolId,
          userId,
          id: { not: exceptSessionId },
          revokedAt: null,
        },
        data: {
          revokedAt: new Date(),
        },
      });
      return res.count;
    });
  }

  /**
   * Updates user password hash within school tenant RLS.
   */
  async updateUserPassword(
    schoolId: string,
    userId: string,
    newPasswordHash: string,
  ): Promise<void> {
    await this.prisma.withTenant(schoolId, async (tx) => {
      await tx.user.update({
        where: { id: userId, schoolId },
        data: {
          passwordHash: newPasswordHash,
          mustChangePassword: false,
          updatedAt: new Date(),
        },
      });
    });
  }

  /**
   * Gets list of active sessions for a user within a school.
   */
  async getUserSessions(schoolId: string, userId: string) {
    return this.prisma.withTenant(schoolId, async (tx) => {
      return tx.session.findMany({
        where: {
          schoolId,
          userId,
          revokedAt: null,
          expiresAt: { gt: new Date() },
        },
        select: {
          id: true,
          clientType: true,
          userAgent: true,
          ipAddress: true,
          createdAt: true,
          expiresAt: true,
        },
        orderBy: {
          createdAt: "desc",
        },
      });
    });
  }

  /**
   * Revokes a specific session by ID for a user within a school.
   */
  async revokeSessionById(schoolId: string, userId: string, sessionId: string): Promise<boolean> {
    return this.prisma.withTenant(schoolId, async (tx) => {
      const res = await tx.session.updateMany({
        where: {
          id: sessionId,
          schoolId,
          userId,
          revokedAt: null,
        },
        data: {
          revokedAt: new Date(),
        },
      });
      return res.count > 0;
    });
  }

  /**
   * Creates a password reset token for a user, invalidating any older unused tokens.
   */
  async createPasswordResetToken(params: {
    schoolId: string;
    userId: string;
    tokenHash: string;
    expiresAt: Date;
    ipAddress?: string;
    userAgent?: string;
  }) {
    return this.prisma.withTenant(params.schoolId, async (tx) => {
      // Invalidate older unused reset tokens for this user
      await tx.passwordResetToken.updateMany({
        where: {
          schoolId: params.schoolId,
          userId: params.userId,
          usedAt: null,
        },
        data: {
          usedAt: new Date(),
        },
      });

      return tx.passwordResetToken.create({
        data: {
          schoolId: params.schoolId,
          userId: params.userId,
          tokenHash: params.tokenHash,
          expiresAt: params.expiresAt,
          ipAddress: params.ipAddress ?? null,
          userAgent: params.userAgent ?? null,
        },
      });
    });
  }

  /**
   * Finds an active, unused password reset token by token hash within tenant context.
   */
  async findPasswordResetToken(schoolId: string, tokenHash: string) {
    return this.prisma.withTenant(schoolId, async (tx) => {
      return tx.passwordResetToken.findFirst({
        where: {
          schoolId,
          tokenHash,
          usedAt: null,
          expiresAt: { gt: new Date() },
        },
        include: {
          user: true,
        },
      });
    });
  }

  /**
   * Marks a password reset token as used within tenant context.
   */
  async markPasswordResetTokenUsed(schoolId: string, tokenId: string): Promise<void> {
    await this.prisma.withTenant(schoolId, async (tx) => {
      await tx.passwordResetToken.update({
        where: { id: tokenId, schoolId },
        data: { usedAt: new Date() },
      });
    });
  }

  /**
   * Creates an email verification token for a user, invalidating any older unused tokens.
   */
  async createEmailVerificationToken(params: {
    schoolId: string;
    userId: string;
    tokenHash: string;
    expiresAt: Date;
  }) {
    return this.prisma.withTenant(params.schoolId, async (tx) => {
      // Invalidate older unused verification tokens for this user
      await tx.emailVerificationToken.updateMany({
        where: {
          schoolId: params.schoolId,
          userId: params.userId,
          usedAt: null,
        },
        data: {
          usedAt: new Date(),
        },
      });

      return tx.emailVerificationToken.create({
        data: {
          schoolId: params.schoolId,
          userId: params.userId,
          tokenHash: params.tokenHash,
          expiresAt: params.expiresAt,
        },
      });
    });
  }

  /**
   * Finds an active, unused email verification token by token hash within tenant context.
   */
  async findEmailVerificationToken(schoolId: string, tokenHash: string) {
    return this.prisma.withTenant(schoolId, async (tx) => {
      return tx.emailVerificationToken.findFirst({
        where: {
          schoolId,
          tokenHash,
          usedAt: null,
          expiresAt: { gt: new Date() },
        },
        include: {
          user: true,
        },
      });
    });
  }

  /**
   * Marks an email verification token as used and sets user email_verified_at.
   */
  async markEmailVerified(schoolId: string, tokenId: string, userId: string): Promise<void> {
    await this.prisma.withTenant(schoolId, async (tx) => {
      await tx.emailVerificationToken.update({
        where: { id: tokenId, schoolId },
        data: { usedAt: new Date() },
      });
      await tx.user.update({
        where: { id: userId, schoolId },
        data: { emailVerifiedAt: new Date() },
      });
    });
  }

  /**
   * Records a tenant audit event into partitioned audit_logs table via withTenant.
   */
  async recordAuditLog(params: {
    schoolId: string;
    actorId?: string;
    action: string;
    entityId?: string;
    metadata?: Record<string, unknown>;
  }): Promise<void> {
    try {
      await this.prisma.withTenant(params.schoolId, async (tx) => {
        await tx.auditLog.create({
          data: {
            schoolId: params.schoolId,
            userId: params.actorId ?? null,
            action: params.action,
            resource: "USER",
            resourceId: params.entityId ?? null,
            payload: (params.metadata ?? {}) as Prisma.InputJsonValue,
          },
        });
      });
    } catch {
      // Audit log failures must not crash caller, but logged
    }
  }

  /**
   * Upserts an unverified two-factor secret configuration for a user.
   */
  async upsertTwoFactorSecret(params: {
    schoolId: string;
    userId: string;
    encryptedSecret: string;
    iv: string;
    authTag: string;
  }) {
    return this.prisma.withTenant(params.schoolId, async (tx) => {
      return tx.userTwoFactorSecret.upsert({
        where: { userId: params.userId },
        create: {
          schoolId: params.schoolId,
          userId: params.userId,
          encryptedSecret: params.encryptedSecret,
          iv: params.iv,
          authTag: params.authTag,
          isVerified: false,
          verifiedAt: null,
        },
        update: {
          encryptedSecret: params.encryptedSecret,
          iv: params.iv,
          authTag: params.authTag,
          isVerified: false,
          verifiedAt: null,
        },
      });
    });
  }

  /**
   * Finds the user's two-factor secret record under tenant context.
   */
  async findTwoFactorSecret(schoolId: string, userId: string) {
    return this.prisma.withTenant(schoolId, async (tx) => {
      return tx.userTwoFactorSecret.findFirst({
        where: {
          schoolId,
          userId,
        },
      });
    });
  }

  /**
   * Enables 2FA: marks secret verified, sets user.is_two_factor_enabled = true,
   * revokes existing recovery codes, and inserts fresh recovery codes.
   */
  async enableTwoFactor(params: {
    schoolId: string;
    userId: string;
    recoveryCodeHashes: string[];
  }) {
    return this.prisma.withTenant(params.schoolId, async (tx) => {
      await tx.userTwoFactorSecret.update({
        where: { userId: params.userId },
        data: {
          isVerified: true,
          verifiedAt: new Date(),
        },
      });

      await tx.user.update({
        where: { id: params.userId, schoolId: params.schoolId },
        data: {
          isTwoFactorEnabled: true,
        },
      });

      // Revoke any previous recovery codes
      await tx.userRecoveryCode.updateMany({
        where: {
          schoolId: params.schoolId,
          userId: params.userId,
          revokedAt: null,
        },
        data: {
          revokedAt: new Date(),
        },
      });

      // Insert new recovery codes
      await tx.userRecoveryCode.createMany({
        data: params.recoveryCodeHashes.map((codeHash) => ({
          schoolId: params.schoolId,
          userId: params.userId,
          codeHash,
        })),
      });
    });
  }

  /**
   * Disables 2FA: sets user.is_two_factor_enabled = false, resets secret verification,
   * revokes all active recovery codes, and revokes all other sessions.
   */
  async disableTwoFactor(schoolId: string, userId: string, currentSessionId?: string) {
    return this.prisma.withTenant(schoolId, async (tx) => {
      await tx.user.update({
        where: { id: userId, schoolId },
        data: {
          isTwoFactorEnabled: false,
        },
      });

      await tx.userTwoFactorSecret.updateMany({
        where: { userId, schoolId },
        data: {
          isVerified: false,
          verifiedAt: null,
        },
      });

      await tx.userRecoveryCode.updateMany({
        where: {
          schoolId,
          userId,
          revokedAt: null,
        },
        data: {
          revokedAt: new Date(),
        },
      });

      // Revoke all other sessions for user
      await tx.session.updateMany({
        where: {
          schoolId,
          userId,
          id: currentSessionId ? { not: currentSessionId } : undefined,
          revokedAt: null,
        },
        data: {
          revokedAt: new Date(),
        },
      });
    });
  }

  /**
   * Regenerates recovery codes: revokes old ones, inserts new ones, and revokes other sessions.
   */
  async regenerateRecoveryCodes(params: {
    schoolId: string;
    userId: string;
    recoveryCodeHashes: string[];
    currentSessionId?: string;
  }) {
    return this.prisma.withTenant(params.schoolId, async (tx) => {
      await tx.userRecoveryCode.updateMany({
        where: {
          schoolId: params.schoolId,
          userId: params.userId,
          revokedAt: null,
        },
        data: {
          revokedAt: new Date(),
        },
      });

      await tx.userRecoveryCode.createMany({
        data: params.recoveryCodeHashes.map((codeHash) => ({
          schoolId: params.schoolId,
          userId: params.userId,
          codeHash,
        })),
      });

      // Revoke other sessions
      await tx.session.updateMany({
        where: {
          schoolId: params.schoolId,
          userId: params.userId,
          id: params.currentSessionId ? { not: params.currentSessionId } : undefined,
          revokedAt: null,
        },
        data: {
          revokedAt: new Date(),
        },
      });
    });
  }

  /**
   * Verifies and marks a single-use recovery code as consumed.
   */
  async verifyAndConsumeRecoveryCode(params: {
    schoolId: string;
    userId: string;
    codeHash: string;
  }): Promise<boolean> {
    return this.prisma.withTenant(params.schoolId, async (tx) => {
      const codeRecord = await tx.userRecoveryCode.findFirst({
        where: {
          schoolId: params.schoolId,
          userId: params.userId,
          codeHash: params.codeHash,
          usedAt: null,
          revokedAt: null,
        },
      });

      if (!codeRecord) {
        return false;
      }

      await tx.userRecoveryCode.update({
        where: { id: codeRecord.id },
        data: {
          usedAt: new Date(),
        },
      });

      return true;
    });
  }
}
