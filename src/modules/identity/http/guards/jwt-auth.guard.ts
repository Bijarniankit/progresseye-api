import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import { TenantContextService } from "../../../../common/request-context/tenant-context.service";
import { TokenService } from "../../domain/token.service";

export interface AuthenticatedUser {
  userId: string;
  schoolId: string;
  sessionId: string;
  scope?: string;
}

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly tokenService: TokenService,
    private readonly tenantContext: TenantContextService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context
      .switchToHttp()
      .getRequest<FastifyRequest & { user?: AuthenticatedUser }>();
    const authHeader = request.headers.authorization;

    if (!authHeader || typeof authHeader !== "string") {
      throw new UnauthorizedException("Authorization header is required");
    }

    const [scheme, token] = authHeader.split(" ");
    if (scheme?.toLowerCase() !== "bearer" || !token) {
      throw new UnauthorizedException("Invalid authorization scheme. Bearer token required.");
    }

    const claims = await this.tokenService.verifyAccessToken(token);

    if (claims.scope === "2fa_pending" || claims.scope === "platform_2fa_pending") {
      throw new ForbiddenException(
        "Two-factor authentication completion required before accessing this resource.",
      );
    }

    if (claims.scope === "pwd_change_pending") {
      throw new ForbiddenException("Password change required before accessing this resource.");
    }

    if (claims.scope === "2fa_setup_pending") {
      const url = request.url || "";
      if (!url.includes("/2fa/setup") && !url.includes("/2fa/enable")) {
        throw new ForbiddenException(
          "Two-factor authentication setup required before accessing this resource.",
        );
      }
    } else if (claims.scope && claims.scope !== "access" && claims.scope !== "platform") {
      throw new ForbiddenException("Invalid token scope for this resource.");
    }

    // Validate that schoolId is a valid non-nil UUID
    this.tenantContext.validateTenantId(claims.schoolId);

    // Tenant for protected requests comes ONLY from the verified access token (Amendment 1)
    request.user = {
      userId: claims.sub,
      schoolId: claims.schoolId,
      sessionId: claims.sessionId,
      scope: claims.scope,
    };

    return true;
  }
}
