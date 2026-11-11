import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { FastifyRequest } from "fastify";
import { RoleService } from "../../modules/identity/application/role.service";
import { AbilityFactory } from "../../modules/identity/domain/ability.factory";
import { IS_AUTHENTICATED_KEY } from "../decorators/authenticated.decorator";
import { IS_PUBLIC_KEY } from "../decorators/public.decorator";
import {
  type PermissionRequirement,
  REQUIRED_PERMISSIONS_KEY,
} from "../decorators/require-permission.decorator";

interface RequestWithUser extends FastifyRequest {
  user?: {
    userId: string;
    schoolId: string;
    sessionId: string;
  };
}

@Injectable()
export class PoliciesGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly roleService: RoleService,
    private readonly abilityFactory: AbilityFactory,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    // 1. Check if explicitly marked Public
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (isPublic) {
      return true;
    }

    // Check if explicitly marked Authenticated (requires valid session, exempt from RBAC)
    const isAuthenticated = this.reflector.getAllAndOverride<boolean>(IS_AUTHENTICATED_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (isAuthenticated) {
      const request = context.switchToHttp().getRequest<RequestWithUser>();
      if (!request.user || !request.user.userId || !request.user.schoolId) {
        throw new UnauthorizedException("Authentication required to access this resource");
      }
      return true;
    }

    // 2. Check for required permissions
    const requirements = this.reflector.getAllAndOverride<PermissionRequirement[]>(
      REQUIRED_PERMISSIONS_KEY,
      [context.getHandler(), context.getClass()],
    );

    // If no permission requirements declared on a non-public route
    if (!requirements || requirements.length === 0) {
      return true;
    }

    const request = context.switchToHttp().getRequest<RequestWithUser>();
    if (!request.user || !request.user.userId || !request.user.schoolId) {
      throw new UnauthorizedException("Authentication required to evaluate authorization policy");
    }

    // 3. Load effective permissions for the tenant context
    const permissions = await this.roleService.getEffectivePermissions(
      request.user.schoolId,
      request.user.userId,
    );

    // 4. Construct CASL ability engine
    const ability = this.abilityFactory.createForUser({
      userId: request.user.userId,
      schoolId: request.user.schoolId,
      permissions,
    });

    // 5. Evaluate all declared requirements
    for (const req of requirements) {
      const hasDirectCode = ability.can(req.code, "all");
      const hasActionResource = ability.can(req.action, req.resource);

      if (!hasDirectCode && !hasActionResource) {
        throw new ForbiddenException({
          statusCode: 403,
          code: "FORBIDDEN_INSUFFICIENT_PERMISSIONS",
          message: `Access denied: missing required permission '${req.code}'`,
        });
      }
    }

    return true;
  }
}
