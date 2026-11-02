import { Global, Module } from "@nestjs/common";
import { TenantContextModule } from "../../common/request-context/tenant-context.module";
import { PrismaService } from "./prisma.service";

@Global()
@Module({
  imports: [TenantContextModule],
  providers: [PrismaService],
  exports: [PrismaService],
})
export class PrismaModule {}
