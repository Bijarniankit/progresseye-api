import { Module } from "@nestjs/common";
import { TenantContextModule } from "../../common/request-context/tenant-context.module";
import { ConfigModule } from "../../config/config.module";
import { PrismaModule } from "../../infra/prisma/prisma.module";
import { RedisModule } from "../../infra/redis/redis.module";
import { AuthService } from "./application/auth.service";
import { AbusePreventionService } from "./domain/abuse-prevention.service";
import { PasswordService } from "./domain/password.service";
import { TokenService } from "./domain/token.service";
import { TotpService } from "./domain/totp.service";
import { AuthController } from "./http/auth.controller";
import { JwtAuthGuard } from "./http/guards/jwt-auth.guard";
import { TenantContextInterceptor } from "./http/interceptors/tenant-context.interceptor";
import { AuthEmailNotificationService } from "./infra/auth-email-notification.service";
import { SessionRepository } from "./infra/session.repository";

@Module({
  imports: [ConfigModule, TenantContextModule, PrismaModule, RedisModule],
  controllers: [AuthController],
  providers: [
    PasswordService,
    TokenService,
    TotpService,
    AbusePreventionService,
    SessionRepository,
    AuthEmailNotificationService,
    AuthService,
    JwtAuthGuard,
    TenantContextInterceptor,
  ],
  exports: [
    AuthService,
    TokenService,
    TotpService,
    PasswordService,
    JwtAuthGuard,
    TenantContextInterceptor,
    AuthEmailNotificationService,
  ],
})
export class IdentityModule {}
