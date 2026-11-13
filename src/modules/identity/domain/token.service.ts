import crypto from "node:crypto";
import { BadRequestException, Injectable, UnauthorizedException } from "@nestjs/common";
import { jwtVerify, SignJWT } from "jose";
import { SYSTEM_TENANT_ID } from "../../../common/request-context/tenant-context.service";
import { AppConfigService } from "../../../config/config.service";

export interface AccessTokenClaims {
  sub: string; // userId
  schoolId: string;
  sessionId: string;
  scope?: string;
  iat?: number;
  exp?: number;
}

@Injectable()
export class TokenService {
  private readonly jwtSecret: Uint8Array;
  private readonly jwtKid: string;

  constructor(private readonly config: AppConfigService) {
    const secret = this.config.get("AUTH_JWT_SECRET");
    this.jwtSecret = new TextEncoder().encode(secret);
    this.jwtKid = this.config.get("AUTH_JWT_KID");
  }

  /**
   * Generates a cryptographically strong, opaque 48-byte URL-safe refresh token.
   */
  generateRefreshToken(): string {
    return crypto.randomBytes(48).toString("base64url");
  }

  /**
   * Computes a SHA-256 hash of a refresh token for storage and lookups.
   */
  hashToken(token: string): string {
    return crypto.createHash("sha256").update(token).digest("hex");
  }

  /**
   * Builds the compound refresh token format (<schoolId>.<rawToken>).
   * Ensures the school context is explicitly bound to the token transport without BYPASSRLS.
   */
  buildCompoundRefreshToken(schoolId: string, rawToken: string): string {
    return `${schoolId}.${rawToken}`;
  }

  /**
   * Parses and validates a compound refresh token string.
   */
  parseCompoundRefreshToken(compound: string): { schoolId: string; rawToken: string } {
    if (!compound || typeof compound !== "string") {
      throw new UnauthorizedException("Refresh token is required");
    }
    const dotIndex = compound.indexOf(".");
    if (dotIndex === -1) {
      throw new UnauthorizedException("Malformed refresh token structure");
    }
    const schoolId = compound.slice(0, dotIndex).trim();
    const rawToken = compound.slice(dotIndex + 1).trim();

    if (!schoolId || !rawToken) {
      throw new UnauthorizedException("Invalid refresh token components");
    }

    return { schoolId, rawToken };
  }

  /**
   * Generates a cryptographically strong 32-byte hex lifecycle token (password reset or email verification).
   */
  generateLifecycleToken(): string {
    return crypto.randomBytes(32).toString("hex");
  }

  /**
   * Builds the compound lifecycle token format (<schoolId>.<rawToken>).
   */
  buildCompoundLifecycleToken(schoolId: string, rawToken: string): string {
    return `${schoolId}.${rawToken}`;
  }

  /**
   * Parses and validates a compound lifecycle token string.
   */
  parseCompoundLifecycleToken(compound: string): { schoolId: string; rawToken: string } {
    if (!compound || typeof compound !== "string") {
      throw new BadRequestException("Token is required");
    }
    const dotIndex = compound.indexOf(".");
    if (dotIndex === -1) {
      throw new BadRequestException("Invalid or expired token structure");
    }
    const schoolId = compound.slice(0, dotIndex).trim();
    const rawToken = compound.slice(dotIndex + 1).trim();

    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    if (!schoolId || !rawToken || !uuidRegex.test(schoolId)) {
      throw new BadRequestException("Invalid or expired token format");
    }

    return { schoolId, rawToken };
  }

  /**
   * Signs a 5-minute temporary token restricted to completing two-factor authentication.
   */
  async createTemporaryTwoFactorToken(claims: {
    userId: string;
    schoolId: string;
  }): Promise<{ token: string; expiresIn: number }> {
    const expiresInSeconds = 5 * 60; // 5 minutes
    const token = await new SignJWT({
      schoolId: claims.schoolId,
      scope: "2fa_pending",
    })
      .setSubject(claims.userId)
      .setProtectedHeader({ alg: "HS256", kid: this.jwtKid })
      .setIssuedAt()
      .setExpirationTime(`${expiresInSeconds}s`)
      .sign(this.jwtSecret);

    return { token, expiresIn: expiresInSeconds };
  }

  /**
   * Signs a 15-minute temporary token restricted to first-login password change.
   */
  async createTemporaryPasswordChangeToken(claims: {
    userId: string;
    schoolId: string;
  }): Promise<{ token: string; expiresIn: number }> {
    const expiresInSeconds = 15 * 60; // 15 minutes
    const token = await new SignJWT({
      schoolId: claims.schoolId,
      scope: "pwd_change_pending",
    })
      .setSubject(claims.userId)
      .setProtectedHeader({ alg: "HS256", kid: this.jwtKid })
      .setIssuedAt()
      .setExpirationTime(`${expiresInSeconds}s`)
      .sign(this.jwtSecret);

    return { token, expiresIn: expiresInSeconds };
  }

  /**
   * Signs a 5-minute temporary token for platform 2FA verification or onboarding setup.
   */
  async createTemporaryPlatformTwoFactorToken(claims: {
    userId: string;
    setup?: boolean;
  }): Promise<{ token: string; expiresIn: number }> {
    const expiresInSeconds = 5 * 60; // 5 minutes
    const scope = claims.setup ? "platform_2fa_setup_pending" : "platform_2fa_pending";
    const token = await new SignJWT({
      schoolId: SYSTEM_TENANT_ID,
      scope,
    })
      .setSubject(claims.userId)
      .setProtectedHeader({ alg: "HS256", kid: this.jwtKid })
      .setIssuedAt()
      .setExpirationTime(`${expiresInSeconds}s`)
      .sign(this.jwtSecret);

    return { token, expiresIn: expiresInSeconds };
  }

  /**
   * Signs a 15-minute temporary token restricted to initial 2FA setup.
   */
  async createTemporaryTwoFactorSetupToken(claims: {
    userId: string;
    schoolId: string;
  }): Promise<{ token: string; expiresIn: number }> {
    const expiresInSeconds = 15 * 60;
    const token = await new SignJWT({
      schoolId: claims.schoolId,
      scope: "2fa_setup_pending",
    })
      .setSubject(claims.userId)
      .setProtectedHeader({ alg: "HS256", kid: this.jwtKid })
      .setIssuedAt()
      .setExpirationTime(`${expiresInSeconds}s`)
      .sign(this.jwtSecret);

    return { token, expiresIn: expiresInSeconds };
  }

  /**
   * Signs a 15-minute access token for platform admin with scope: "platform".
   */
  async createPlatformAccessToken(claims: {
    userId: string;
    sessionId: string;
  }): Promise<{ token: string; expiresIn: number }> {
    const expiresInSeconds = 15 * 60; // 15 minutes
    const token = await new SignJWT({
      schoolId: SYSTEM_TENANT_ID,
      sessionId: claims.sessionId,
      scope: "platform",
    })
      .setSubject(claims.userId)
      .setProtectedHeader({ alg: "HS256", kid: this.jwtKid })
      .setIssuedAt()
      .setExpirationTime(`${expiresInSeconds}s`)
      .sign(this.jwtSecret);

    return { token, expiresIn: expiresInSeconds };
  }

  /**
   * Signs a 15-minute access token via jose with HS256 and key id.
   */
  async createAccessToken(claims: {
    userId: string;
    schoolId: string;
    sessionId: string;
  }): Promise<{ token: string; expiresIn: number }> {
    const expiresInSeconds = 15 * 60; // 15 minutes
    const token = await new SignJWT({
      schoolId: claims.schoolId,
      sessionId: claims.sessionId,
      scope: "access",
    })
      .setSubject(claims.userId)
      .setProtectedHeader({ alg: "HS256", kid: this.jwtKid })
      .setIssuedAt()
      .setExpirationTime(`${expiresInSeconds}s`)
      .sign(this.jwtSecret);

    return { token, expiresIn: expiresInSeconds };
  }

  /**
   * Verifies an access token with strict algorithm whitelisting (HS256 only).
   */
  async verifyAccessToken(token: string): Promise<AccessTokenClaims> {
    try {
      const { payload } = await jwtVerify(token, this.jwtSecret, {
        algorithms: ["HS256"],
      });

      if (!payload.sub || !payload.schoolId) {
        throw new UnauthorizedException("Invalid token payload claims");
      }

      const scope = (payload.scope as string) || "access";
      if (
        scope === "pwd_change_pending" ||
        scope === "2fa_pending" ||
        scope === "2fa_setup_pending" ||
        scope === "platform_2fa_pending" ||
        scope === "platform_2fa_setup_pending"
      ) {
        return {
          sub: payload.sub,
          schoolId: payload.schoolId as string,
          sessionId: scope,
          scope,
          iat: payload.iat,
          exp: payload.exp,
        };
      }

      if (!payload.sessionId) {
        throw new UnauthorizedException("Invalid token payload claims");
      }

      return {
        sub: payload.sub,
        schoolId: payload.schoolId as string,
        sessionId: payload.sessionId as string,
        scope,
        iat: payload.iat,
        exp: payload.exp,
      };
    } catch {
      throw new UnauthorizedException("Invalid or expired access token");
    }
  }
}
