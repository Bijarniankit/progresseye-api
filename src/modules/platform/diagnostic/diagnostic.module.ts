import { Module } from "@nestjs/common";
import { ConfigModule } from "../../../config/config.module";
import { DiagnosticController } from "./diagnostic.controller";

@Module({
  imports: [ConfigModule],
  controllers: [DiagnosticController],
})
export class DiagnosticModule {}
