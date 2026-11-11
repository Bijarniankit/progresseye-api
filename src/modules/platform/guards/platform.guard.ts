import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import { SYSTEM_TENANT_ID } from "../../../common/request-context/tenant-context.service";

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
  canActivate(context: ExecutionContext): boolean {
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

    return true;
  }
}
