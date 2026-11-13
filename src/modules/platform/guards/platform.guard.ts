import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import { SYSTEM_TENANT_ID } from "../../../common/request-context/tenant-context.service";
import { PrismaService } from "../../../infra/prisma/prisma.service";

interface RequestWithUser extends FastifyRequest {
  user?: {
    userId: string;
    schoolId: string;
    sessionId: string;
    scope?: string;
  };
}

@Injectable()
export class PlatformGuard implements CanActivate {
  constructor(private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<RequestWithUser>();
    const user = request.user;

    if (!user || !user.userId) {
      throw new UnauthorizedException("Authentication required.");
    }

    if (user.schoolId !== SYSTEM_TENANT_ID || user.scope !== "platform") {
      throw new ForbiddenException(
        "Platform administrative access required. Tenant credentials cannot access platform operations.",
      );
    }

    // Direct database validation per request under system tenant.
    // Zero caching ensures instant enforcement of deactivations, role revocations, and session invalidations.
    const dbUser = await this.prisma.withTenant(SYSTEM_TENANT_ID, async (tx) => {
      return tx.user.findFirst({
        where: {
          id: user.userId,
          schoolId: SYSTEM_TENANT_ID,
          deletedAt: null,
        },
        include: {
          userRoles: {
            where: {
              role: {
                slug: "platform_admin",
              },
            },
          },
          sessions: {
            where: {
              id: user.sessionId,
              revokedAt: null,
              expiresAt: { gt: new Date() },
            },
          },
        },
      });
    });

    if (!dbUser || !dbUser.isActive) {
      throw new UnauthorizedException("Platform administrator account is inactive or not found.");
    }

    if (!dbUser.userRoles || dbUser.userRoles.length === 0) {
      throw new ForbiddenException("Platform administrator role has been revoked.");
    }

    if (!dbUser.sessions || dbUser.sessions.length === 0) {
      throw new UnauthorizedException(
        "Platform administrator session has been revoked or expired.",
      );
    }

    return true;
  }
}
