import { Injectable, Logger } from "@nestjs/common";
import { hmacHash } from "../../../common/utils/sanitization";
import { AppConfigService } from "../../../config/config.service";
import { PrismaService } from "../../../infra/prisma/prisma.service";

export interface PlatformAuditEntry {
  actorUserId?: string | null;
  action: string;
  resource: string;
  resourceId?: string | null;
  payload?: Record<string, unknown>;
  clientIp?: string | null;
  userAgent?: string | null;
}

@Injectable()
export class PlatformAuditService {
  private readonly logger = new Logger(PlatformAuditService.name);
  private readonly hmacSecret: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: AppConfigService,
  ) {
    this.hmacSecret = this.config.get("AUTH_LOG_HMAC_SECRET");
  }

  /**
   * Appends an audit row to platform_audit_logs via raw SQL without RETURNING clause.
   * Required because progresseye_app only holds INSERT privilege (no SELECT).
   */
  async recordEvent(entry: PlatformAuditEntry): Promise<void> {
    const clientIpHmac = entry.clientIp ? hmacHash(entry.clientIp, this.hmacSecret) : null;
    const sanitizedPayload = this.sanitizePayload(entry.payload ?? {});

    try {
      await this.prisma.$executeRaw`
        INSERT INTO "platform_audit_logs" (
          "id",
          "actor_user_id",
          "action",
          "resource",
          "resource_id",
          "payload",
          "client_ip_hash",
          "user_agent",
          "created_at"
        ) VALUES (
          gen_random_uuid(),
          ${entry.actorUserId ? entry.actorUserId : null}::uuid,
          ${entry.action},
          ${entry.resource},
          ${entry.resourceId ?? null},
          ${JSON.stringify(sanitizedPayload)}::jsonb,
          ${clientIpHmac},
          ${entry.userAgent ?? null},
          CURRENT_TIMESTAMP(3)
        )
      `;
    } catch (error) {
      this.logger.error({
        event: "platform_audit_write_failed",
        action: entry.action,
        resource: entry.resource,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Strips any sensitive fields from the payload, preserving only IDs and field names.
   */
  private sanitizePayload(payload: Record<string, unknown>): Record<string, unknown> {
    const sensitiveKeys = new Set([
      "password",
      "currentPassword",
      "newPassword",
      "token",
      "refreshToken",
      "otp",
      "code",
      "recoveryCode",
      "twoFactorSecret",
      "secret",
      "apiKey",
      "bootstrapSecret",
    ]);

    const sanitized: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(payload)) {
      if (sensitiveKeys.has(key)) {
        sanitized[key] = "[REDACTED]";
      } else if (typeof value === "object" && value !== null && !Array.isArray(value)) {
        sanitized[key] = this.sanitizePayload(value as Record<string, unknown>);
      } else {
        sanitized[key] = value;
      }
    }
    return sanitized;
  }
}
