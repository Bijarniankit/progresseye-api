import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
  Optional,
} from "@nestjs/common";
import { Queue, Worker } from "bullmq";
import { AppConfigService } from "../../../config/config.service";
import { RedisService } from "../../../infra/redis/redis.service";
import {
  EMAIL_DELIVERY_SERVICE,
  type IEmailDeliveryService,
  SmtpEmailDeliveryService,
} from "../../public/domain/notification/email-delivery.service";

export interface AuthEmailJobPayload {
  type: "PASSWORD_RESET" | "EMAIL_VERIFICATION";
  to: string;
  compoundToken: string;
}

export const AUTH_EMAIL_QUEUE = "auth-email-notifications";

@Injectable()
export class AuthEmailNotificationService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AuthEmailNotificationService.name);
  private queue: Queue<AuthEmailJobPayload> | null = null;
  private worker: Worker<AuthEmailJobPayload> | null = null;
  private readonly appPublicUrl: string;

  constructor(
    private readonly config: AppConfigService,
    private readonly redisService: RedisService,
    @Optional()
    @Inject(EMAIL_DELIVERY_SERVICE)
    private readonly emailDeliveryService?: IEmailDeliveryService,
  ) {
    this.appPublicUrl = this.config.get("APP_PUBLIC_URL") || "http://localhost:3000";
    if (!this.emailDeliveryService) {
      this.emailDeliveryService = new SmtpEmailDeliveryService(this.config);
    }
  }

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
      this.queue = new Queue<AuthEmailJobPayload>(AUTH_EMAIL_QUEUE, {
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

      this.worker = new Worker<AuthEmailJobPayload>(
        AUTH_EMAIL_QUEUE,
        async (job) => {
          await this.processJob(job.data);
        },
        { connection },
      );

      this.worker.on("failed", (job, err) => {
        this.logger.error({
          event: "auth_email_job_failed",
          jobId: job?.id,
          type: job?.data.type,
          error: err.message,
        });
      });
    } catch (err) {
      this.logger.warn({
        event: "bullmq_init_warning",
        message: "Failed to initialize BullMQ queue for auth emails; fallback to direct delivery",
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
   * Enqueues or delivers a password reset email.
   * Token is placed in URL fragment (#token=...), never in query string.
   */
  async sendPasswordResetEmail(to: string, compoundToken: string): Promise<void> {
    if (this.queue) {
      try {
        await this.queue.add("send-password-reset", {
          type: "PASSWORD_RESET",
          to,
          compoundToken,
        });
        return;
      } catch (err) {
        this.logger.warn({
          event: "auth_email_queue_error",
          message: "Failed to enqueue password reset email, attempting direct delivery",
          error: (err as Error).message,
        });
      }
    }

    // Direct fallback if queue not active
    await this.processJob({
      type: "PASSWORD_RESET",
      to,
      compoundToken,
    });
  }

  /**
   * Enqueues or delivers an email verification email.
   * Token is placed in URL fragment (#token=...), never in query string.
   */
  async sendEmailVerificationEmail(to: string, compoundToken: string): Promise<void> {
    if (this.queue) {
      try {
        await this.queue.add("send-email-verification", {
          type: "EMAIL_VERIFICATION",
          to,
          compoundToken,
        });
        return;
      } catch (err) {
        this.logger.warn({
          event: "auth_email_queue_error",
          message: "Failed to enqueue email verification, attempting direct delivery",
          error: (err as Error).message,
        });
      }
    }

    // Direct fallback if queue not active
    await this.processJob({
      type: "EMAIL_VERIFICATION",
      to,
      compoundToken,
    });
  }

  private async processJob(payload: AuthEmailJobPayload): Promise<void> {
    if (!this.emailDeliveryService) return;

    if (payload.type === "PASSWORD_RESET") {
      const resetUrl = `${this.appPublicUrl}/auth/reset-password#token=${payload.compoundToken}`;
      await this.emailDeliveryService.sendEmail({
        to: payload.to,
        subject: "Reset Your ProgressEye Password",
        text: `You requested a password reset for ProgressEye. Please use the following link to reset your password:\n\n${resetUrl}\n\nThis link will expire in 1 hour. If you did not request this, please ignore this email.`,
        html: `<p>You requested a password reset for ProgressEye.</p><p><a href="${resetUrl}">Reset Password</a></p><p>This link will expire in 1 hour. If you did not request this, please ignore this email.</p>`,
      });
    } else if (payload.type === "EMAIL_VERIFICATION") {
      const verifyUrl = `${this.appPublicUrl}/auth/verify-email#token=${payload.compoundToken}`;
      await this.emailDeliveryService.sendEmail({
        to: payload.to,
        subject: "Verify Your ProgressEye Email",
        text: `Please verify your email address for ProgressEye using the following link:\n\n${verifyUrl}\n\nThis link will expire in 24 hours.`,
        html: `<p>Please verify your email address for ProgressEye.</p><p><a href="${verifyUrl}">Verify Email</a></p><p>This link will expire in 24 hours.</p>`,
      });
    }
  }
}
