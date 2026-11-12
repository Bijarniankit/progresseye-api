import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import {
  SYSTEM_TENANT_ID,
  TenantContextService,
} from "../../../common/request-context/tenant-context.service";
import { hmacHash } from "../../../common/utils/sanitization";
import { AppConfigService } from "../../../config/config.service";
import { PrismaService } from "../../../infra/prisma/prisma.service";
import { RoleService } from "../../identity/application/role.service";
import type { CreateSchoolDto } from "../dto/platform-school.dto";
import { PlatformAuditService } from "./platform-audit.service";

@Injectable()
export class PlatformSchoolService {
  private readonly logger = new Logger(PlatformSchoolService.name);
  private readonly hmacSecret: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly roleService: RoleService,
    private readonly platformAuditService: PlatformAuditService,
    private readonly config: AppConfigService,
    private readonly tenantContext: TenantContextService,
  ) {
    this.hmacSecret = this.config.get("AUTH_LOG_HMAC_SECRET");
  }

  /**
   * Provisions a new school tenant via the PostgreSQL SECURITY DEFINER function platform_provision_school.
   * Then seeds the 12 tenant built-in roles under tenant RLS via withPlatformTenant.
   */
  async provisionSchool(
    dto: CreateSchoolDto,
    actorUserId: string,
    meta: { ip: string; userAgent?: string },
  ) {
    return this.tenantContext.run(
      { schoolId: SYSTEM_TENANT_ID, userId: actorUserId, isPlatform: true },
      async () => {
        let newSchoolId: string;
        const clientIpHmac = meta.ip ? hmacHash(meta.ip, this.hmacSecret) : "";
        const userAgentVal = meta.userAgent || "";

        try {
          await this.prisma.$executeRaw`
            SELECT
              set_config('app.current_user_id', ${actorUserId}, true),
              set_config('app.client_ip_hash', ${clientIpHmac}, true),
              set_config('app.user_agent', ${userAgentVal}, true)
          `;

          const rows = await this.prisma.$queryRaw<{ school_id: string }[]>`
            SELECT platform_provision_school(
              ${dto.slug},
              ${dto.name},
              ${dto.organizationId ? dto.organizationId : null}::uuid
            ) AS school_id
          `;

          const firstRow = rows && rows[0];
          if (!firstRow || !firstRow.school_id) {
            throw new Error("platform_provision_school did not return a valid school UUID.");
          }

          newSchoolId = firstRow.school_id;
        } catch (error: any) {
          const message = error?.message || String(error);
          if (message.includes("SLUG_ALREADY_EXISTS")) {
            throw new ConflictException(`School with slug "${dto.slug}" already exists.`);
          }
          if (message.includes("RESERVED_SLUG")) {
            throw new BadRequestException(`Slug "${dto.slug}" is a reserved system identifier.`);
          }
          if (message.includes("INVALID_SLUG") || message.includes("INVALID_NAME")) {
            throw new BadRequestException(message);
          }
          this.logger.error({
            event: "platform_provision_school_failed",
            error: message,
            slug: dto.slug,
          });
          throw error;
        }

        // App-level role seeding via withPlatformTenant
        await this.roleService.seedBuiltInRolesForSchool(newSchoolId, actorUserId);

        await this.platformAuditService.recordEvent({
          actorUserId,
          action: "PLATFORM_SCHOOL_PROVISION_COMPLETE",
          resource: "schools",
          resourceId: newSchoolId,
          payload: {
            schoolId: newSchoolId,
            slug: dto.slug,
            fields: ["name", "slug", "roles"],
          },
          clientIp: meta.ip,
          userAgent: meta.userAgent,
        });

        return {
          id: newSchoolId,
          name: dto.name,
          slug: dto.slug,
          organizationId: dto.organizationId ?? null,
        };
      },
    );
  }

  /**
   * Reseeds/repairs the 12 tenant built-in roles for a provisioned school.
   * Useful if initial role seeding failed or after schema catalog migrations.
   */
  async reseedRoles(
    schoolId: string,
    actorUserId: string,
    meta: { ip: string; userAgent?: string },
  ) {
    return this.tenantContext.run(
      { schoolId: SYSTEM_TENANT_ID, userId: actorUserId, isPlatform: true },
      async () => {
        const school = await this.prisma.school.findUnique({
          where: { id: schoolId },
        });

        if (!school) {
          throw new NotFoundException(`School with ID ${schoolId} not found.`);
        }

        await this.roleService.seedBuiltInRolesForSchool(schoolId, actorUserId);

        await this.platformAuditService.recordEvent({
          actorUserId,
          action: "PLATFORM_SCHOOL_RESEED_ROLES",
          resource: "schools",
          resourceId: schoolId,
          payload: {
            schoolId,
            slug: school.slug,
            fields: ["roles"],
          },
          clientIp: meta.ip,
          userAgent: meta.userAgent,
        });

        return {
          success: true,
          schoolId,
          reseededRoles: 12,
        };
      },
    );
  }
}
