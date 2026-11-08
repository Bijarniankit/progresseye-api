import { Module } from "@nestjs/common";
import { PrismaModule } from "../prisma/prisma.module";
import { OutboxDispatcherService } from "./outbox-dispatcher.service";

@Module({
  imports: [PrismaModule],
  providers: [OutboxDispatcherService],
  exports: [OutboxDispatcherService],
})
export class OutboxModule {}
