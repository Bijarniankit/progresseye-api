import { Module } from "@nestjs/common";
import { PoliciesGuard } from "../../common/guards/policies.guard";
import { TenantContextModule } from "../../common/request-context/tenant-context.module";
import { ConfigModule } from "../../config/config.module";
import { PrismaModule } from "../../infra/prisma/prisma.module";
import { RedisModule } from "../../infra/redis/redis.module";
import { AuthService } from "./application/auth.service";
import { RoleService } from "./application/role.service";
import { AbilityFactory } from "./domain/ability.factory";
import { AbusePreventionService } from "./domain/abuse-prevention.service";
import { PasswordService } from "./domain/password.service";
import { PermissionCacheService } from "./domain/permission-cache.service";
import { TokenService } from "./domain/token.service";
import { TotpService } from "./domain/totp.service";
import { AuthController } from "./http/auth.controller";
import { JwtAuthGuard } from "./http/guards/jwt-auth.guard";
import { TenantContextInterceptor } from "./http/interceptors/tenant-context.interceptor";
import { RoleController } from "./http/role.controller";
import { AuthEmailNotificationService } from "./infra/auth-email-notification.service";
import { SessionRepository } from "./infra/session.repository";

@Module({
  imports: [ConfigModule, TenantContextModule, PrismaModule, RedisModule],
  controllers: [AuthController, RoleController],
  providers: [
    PasswordService,
    TokenService,
    TotpService,
    AbusePreventionService,
    SessionRepository,
    AuthEmailNotificationService,
    AuthService,
    AbilityFactory,
    PermissionCacheService,
    RoleService,
    JwtAuthGuard,
    PoliciesGuard,
    TenantContextInterceptor,
  ],
  exports: [
    AuthService,
    SessionRepository,
    TokenService,
    TotpService,
    PasswordService,
    AbilityFactory,
    PermissionCacheService,
    RoleService,
    JwtAuthGuard,
    PoliciesGuard,
    TenantContextInterceptor,
    AuthEmailNotificationService,
    AbusePreventionService,
  ],
})
export class IdentityModule {}
