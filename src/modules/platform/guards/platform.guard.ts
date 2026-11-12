import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Injectable,
  Logger,
  UnauthorizedException,
} from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import { SYSTEM_TENANT_ID } from "../../../common/request-context/tenant-context.service";
import { PrismaService } from "../../../infra/prisma/prisma.service";
import { RedisService } from "../../../infra/redis/redis.service";

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
  private readonly logger = new Logger(PlatformGuard.name);
  private readonly TTL_SECONDS = 30; // 30s short-lived cache

  constructor(
    private readonly prisma: PrismaService,
    private readonly redisService: RedisService,
  ) {}

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

    // 1. Check short-TTL Redis cache
    const cacheKey = `platform:guard:${user.userId}:${user.sessionId}`;
    const redis = this.redisService.getClient();

    if (redis && redis.status === "ready") {
      try {
        const cached = await redis.get(cacheKey);
        if (cached === "1") {
          return true;
        }
      } catch (err) {
        this.logger.warn(`Platform guard cache read failure: ${(err as Error).message}`);
      }
    }

    // 2. Query DB under system tenant
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

    // 3. Cache valid verification for short TTL
    if (redis && redis.status === "ready") {
      try {
        await redis.set(cacheKey, "1", "EX", this.TTL_SECONDS);
      } catch (err) {
        this.logger.warn(`Platform guard cache write failure: ${(err as Error).message}`);
      }
    }

    return true;
  }
}
