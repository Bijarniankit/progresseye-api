import {
  type CallHandler,
  type ExecutionContext,
  Injectable,
  type NestInterceptor,
} from "@nestjs/common";
import type { Observable } from "rxjs";
import {
  SYSTEM_TENANT_ID,
  TenantContextService,
} from "../../../../common/request-context/tenant-context.service";
import type { AuthenticatedUser } from "../guards/jwt-auth.guard";

@Injectable()
export class TenantContextInterceptor implements NestInterceptor {
  constructor(private readonly tenantContext: TenantContextService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest();
    const user = request.user as AuthenticatedUser | undefined;

    if (user?.schoolId) {
      const isPlatform = user.schoolId === SYSTEM_TENANT_ID && (user as any).scope === "platform";
      return this.tenantContext.runSync(
        { schoolId: user.schoolId, userId: user.userId, isPlatform },
        () => next.handle(),
      );
    }

    return next.handle();
  }
}
