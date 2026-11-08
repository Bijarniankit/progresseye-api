import { Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";

@Injectable()
export class OutboxDispatcherService {
  private readonly logger = new Logger(OutboxDispatcherService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Stub dispatcher for outbox events. In future phases,
   * a scheduled worker polls pending events and dispatches them to message queues.
   */
  async dispatchPendingEvents(): Promise<number> {
    const pending = await this.prisma.outboxEvent.findMany({
      where: { status: "PENDING" },
      take: 50,
      orderBy: { createdAt: "asc" },
    });

    this.logger.debug(`Dispatched/evaluated ${pending.length} pending outbox events (stub)`);
    return pending.length;
  }
}
