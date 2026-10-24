import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from "@nestjs/common";
import { LeadType } from "@prisma/client";
import { Queue, Worker } from "bullmq";
import { AppConfigService } from "../../../../config/config.service";
import { PrismaService } from "../../../../infra/prisma/prisma.service";
import { RedisService } from "../../../../infra/redis/redis.service";
import { EMAIL_DELIVERY_SERVICE, type IEmailDeliveryService } from "./email-delivery.service";

export interface LeadJobPayload {
  leadId: string;
}

export const LEAD_NOTIFICATION_QUEUE = "lead-notifications";
export const LEAD_NOTIFICATION_JOB = "send-lead-notification";

@Injectable()
export class LeadNotificationService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(LeadNotificationService.name);
  private queue: Queue<LeadJobPayload> | null = null;
  private worker: Worker<LeadJobPayload> | null = null;

  constructor(
    private readonly config: AppConfigService,
    private readonly redisService: RedisService,
    private readonly prisma: PrismaService,
    @Inject(EMAIL_DELIVERY_SERVICE)
    private readonly emailService: IEmailDeliveryService,
  ) {}

  onModuleInit(): void {
    const redis = this.redisService.getClient();
    if (redis && redis.status === "ready") {
      this.initBullMq();
    }
  }

  public initBullMq(): void {
    if (this.queue && this.worker) return;

    const host = this.config.get("REDIS_HOST") || "localhost";
    const port = Number(this.config.get("REDIS_PORT") || 6379);
    const password = this.config.get("REDIS_PASSWORD") || undefined;

    const connection = {
      host,
      port,
      password,
      maxRetriesPerRequest: null,
      enableOfflineQueue: false,
      connectTimeout: 1000,
    };

    try {
      this.queue = new Queue<LeadJobPayload>(LEAD_NOTIFICATION_QUEUE, {
        connection,
        defaultJobOptions: {
          attempts: 3,
          backoff: {
            type: "exponential",
            delay: 1000,
          },
          removeOnComplete: true,
        },
      });

      this.worker = new Worker<LeadJobPayload>(
        LEAD_NOTIFICATION_QUEUE,
        async (job) => {
          await this.processJob(job.data.leadId);
        },
        { connection },
      );

      this.worker.on("failed", (job, err) => {
        this.logger.error({
          event: "lead_notification_job_failed",
          jobId: job?.id,
          leadId: job?.data.leadId,
          error: err.message,
        });
      });
    } catch (err) {
      this.logger.warn({
        event: "bullmq_init_warning",
        message: "Failed to initialize BullMQ queue; continuing without worker",
        error: (err as Error).message,
      });
    }
  }

  async onModuleDestroy(): Promise<void> {
    try {
      if (this.worker) {
        await Promise.race([
          this.worker.close(),
          new Promise((resolve) => setTimeout(resolve, 500)),
        ]);
      }
      if (this.queue) {
        await Promise.race([
          this.queue.close(),
          new Promise((resolve) => setTimeout(resolve, 500)),
        ]);
      }
    } catch {
      // Ignore teardown errors
    }
  }

  /**
   * Enqueues an asynchronous notification job for the specified lead ID.
   * In compliance with privacy guidelines, ONLY leadId is transmitted in the payload.
   * Fails gracefully: queue errors never fail the HTTP request.
   */
  async enqueueNotification(leadId: string): Promise<void> {
    try {
      const redis = this.redisService.getClient();
      const isRedisReady = redis && redis.status === "ready";

      if (!this.queue && isRedisReady) {
        this.initBullMq();
      }

      if (this.queue && isRedisReady) {
        await Promise.race([
          this.queue.add(LEAD_NOTIFICATION_JOB, { leadId }),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error("Queue add timeout")), 1000),
          ),
        ]);
        this.logger.log({
          event: "lead_notification_enqueued",
          leadId,
        });
        return;
      }
    } catch (err) {
      this.logger.warn({
        event: "lead_notification_enqueue_failed",
        leadId,
        error: (err as Error).message,
      });
    }

    // Direct fallback if queue is unavailable (e.g. offline dev/testing)
    // Run in background without awaiting so HTTP request is not blocked
    void this.processJob(leadId).catch((err) => {
      this.logger.warn({
        event: "lead_notification_direct_fallback_failed",
        leadId,
        error: (err as Error).message,
      });
    });
  }

  /**
   * Processes the notification: loads lead by ID, verifies type, sends email, and updates notified_at.
   */
  public async processJob(leadId: string): Promise<void> {
    const lead = await this.prisma.lead.findUnique({
      where: { id: leadId },
    });

    if (!lead) {
      this.logger.warn({
        event: "lead_notification_skipped",
        reason: "lead_not_found",
        leadId,
      });
      return;
    }

    // Never send emails for newsletter subscribers
    if (lead.type === LeadType.NEWSLETTER) {
      return;
    }

    // Idempotency: skip if already notified
    if (lead.notifiedAt) {
      this.logger.log({
        event: "lead_notification_skipped",
        reason: "already_notified",
        leadId,
      });
      return;
    }

    const shortId = lead.id.slice(0, 8);
    const subject = `ProgressEye: new lead received (Ref: ${shortId})`;
    const recipient = this.config.get("LEAD_NOTIFICATION_RECIPIENT") || "leads@progresseye.com";

    const bodyLines = [
      "New institutional inquiry received.",
      `Type: ${lead.type}`,
      `Reference ID: ${lead.id}`,
      `Created: ${lead.createdAt.toISOString()}`,
    ];

    if (lead.name) bodyLines.push(`Name: ${lead.name}`);
    if (lead.email) bodyLines.push(`Email: ${lead.email}`);
    if (lead.schoolName) bodyLines.push(`School: ${lead.schoolName}`);
    if (lead.message) bodyLines.push(`Message:\n${lead.message}`);
    bodyLines.push(`Consent Recorded: Yes (${lead.consentText})`);

    const bodyText = bodyLines.join("\n");

    await this.emailService.sendEmail({
      to: recipient,
      subject,
      text: bodyText,
    });

    // Mark as notified in database
    await this.prisma.lead.update({
      where: { id: leadId },
      data: { notifiedAt: new Date() },
    });

    this.logger.log({
      event: "lead_notified",
      leadId,
      subject, // PII-free subject line
    });
  }
}
