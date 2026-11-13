import { Module } from "@nestjs/common";
import { TenantContextModule } from "../../common/request-context/tenant-context.module";
import { ConfigModule } from "../../config/config.module";
import { PrismaModule } from "../../infra/prisma/prisma.module";
import { IdentityModule } from "../identity/identity.module";
import { PlatformAuditService } from "./application/platform-audit.service";
import { PlatformAuthService } from "./application/platform-auth.service";
import { PlatformSchoolService } from "./application/platform-school.service";
import { PlatformGuard } from "./guards/platform.guard";
import { PlatformAuthController } from "./http/platform-auth.controller";
import { PlatformSchoolController } from "./http/platform-school.controller";

@Module({
  imports: [ConfigModule, PrismaModule, IdentityModule, TenantContextModule],
  controllers: [PlatformAuthController, PlatformSchoolController],
  providers: [PlatformAuditService, PlatformAuthService, PlatformSchoolService, PlatformGuard],
  exports: [PlatformAuditService, PlatformGuard, PlatformSchoolService],
})
export class PlatformModule {}
