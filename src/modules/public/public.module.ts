import { Module } from "@nestjs/common";
import { PrismaModule } from "../../infra/prisma/prisma.module";
import { PublicLeadService } from "./application/public-lead.service";
import { PublicController } from "./http/public.controller";

@Module({
  imports: [PrismaModule],
  controllers: [PublicController],
  providers: [PublicLeadService],
  exports: [PublicLeadService],
})
export class PublicModule {}
