import crypto from "node:crypto";
import { Injectable, UnauthorizedException } from "@nestjs/common";
import { jwtVerify, SignJWT } from "jose";
import { AppConfigService } from "../../../config/config.service";

export interface AccessTokenClaims {
  sub: string; // userId
  schoolId: string;
  sessionId: string;
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

      if (!payload.sub || !payload.schoolId || !payload.sessionId) {
        throw new UnauthorizedException("Invalid token payload claims");
      }

      return {
        sub: payload.sub,
        schoolId: payload.schoolId as string,
        sessionId: payload.sessionId as string,
        iat: payload.iat,
        exp: payload.exp,
      };
    } catch {
      throw new UnauthorizedException("Invalid or expired access token");
    }
  }
}
