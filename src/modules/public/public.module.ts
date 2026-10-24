import { Module } from "@nestjs/common";
import { ConfigModule } from "../../config/config.module";
import { PrismaModule } from "../../infra/prisma/prisma.module";
import { RedisModule } from "../../infra/redis/redis.module";
import { PublicLeadService } from "./application/public-lead.service";
import { IdempotencyService } from "./domain/anti-abuse/idempotency.service";
import {
  SPAM_VERIFICATION_SERVICE,
  TurnstileService,
} from "./domain/anti-abuse/spam-verification.service";
import {
  EMAIL_DELIVERY_SERVICE,
  SmtpEmailDeliveryService,
} from "./domain/notification/email-delivery.service";
import { LeadNotificationService } from "./domain/notification/lead-notification.service";
import { PublicRequestGuard } from "./http/guards/public-request-guard";
import { PublicController } from "./http/public.controller";

@Module({
  imports: [ConfigModule, PrismaModule, RedisModule],
  controllers: [PublicController],
  providers: [
    PublicLeadService,
    IdempotencyService,
    LeadNotificationService,
    PublicRequestGuard,
    {
      provide: EMAIL_DELIVERY_SERVICE,
      useClass: SmtpEmailDeliveryService,
    },
    {
      provide: SPAM_VERIFICATION_SERVICE,
      useClass: TurnstileService,
    },
  ],
  exports: [
    PublicLeadService,
    IdempotencyService,
    LeadNotificationService,
    EMAIL_DELIVERY_SERVICE,
    SPAM_VERIFICATION_SERVICE,
  ],
})
export class PublicModule {}
