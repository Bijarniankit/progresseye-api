import * as crypto from "node:crypto";
import { Inject, Injectable, Logger } from "@nestjs/common";
import { LeadStatus, LeadType } from "@prisma/client";
import { AppConfigService } from "../../../config/config.service";
import { PrismaService } from "../../../infra/prisma/prisma.service";
import { IdempotencyService } from "../domain/anti-abuse/idempotency.service";
import {
  type ISpamVerificationService,
  SPAM_VERIFICATION_SERVICE,
} from "../domain/anti-abuse/spam-verification.service";
import { CONSENT_TEMPLATES } from "../domain/consent-templates";
import { LeadNotificationService } from "../domain/notification/lead-notification.service";
import type { ContactLeadDto, DemoLeadDto, NewsletterLeadDto, PublicLeadResponseDto } from "../dto";

export interface RequestClientMeta {
  ip?: string;
  userAgent?: string;
  idempotencyKey?: string;
}

export interface SubmitResult {
  response: PublicLeadResponseDto;
  isReplayed?: boolean;
}

@Injectable()
export class PublicLeadService {
  private readonly logger = new Logger(PublicLeadService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: AppConfigService,
    private readonly idempotencyService: IdempotencyService,
    private readonly notificationService: LeadNotificationService,
    @Inject(SPAM_VERIFICATION_SERVICE)
    private readonly spamService: ISpamVerificationService,
  ) {}

  /**
   * Hashes client IP using cryptographic HMAC with an environment secret.
   * Protects user privacy against precomputed rainbow table attacks while preserving pseudonymous deduplication.
   */
  private hashIp(ip?: string): string | undefined {
    if (!ip) return undefined;
    const secret = this.config.get("LEAD_IP_HMAC_SECRET") || "dev-lead-ip-hmac-secret";
    return crypto.createHmac("sha256", secret).update(ip).digest("hex");
  }

  /**
   * Evaluates the honeypot trap field.
   * If filled, silently returns a dummy 201 receipt without persisting to the database.
   * Logs only { type: LeadType } without any user data.
   */
  private checkHoneypot(
    honeypotValue: string | undefined,
    type: LeadType,
  ): PublicLeadResponseDto | null {
    if (honeypotValue && honeypotValue.trim().length > 0) {
      this.logger.warn({
        event: "honeypot_triggered",
        type,
      });
      return {
        id: crypto.randomUUID(),
        status: "received",
        message: "Inquiry received successfully",
        createdAt: new Date().toISOString(),
      };
    }
    return null;
  }

  async submitContact(dto: ContactLeadDto, meta: RequestClientMeta): Promise<SubmitResult> {
    // 1. Honeypot check
    const honeypotReceipt = this.checkHoneypot(dto.website_url, LeadType.CONTACT);
    if (honeypotReceipt) {
      return { response: honeypotReceipt };
    }

    // 2. Spam verification (Turnstile)
    await this.spamService.verifyToken(dto.turnstileToken);

    // 3. Idempotency handling
    const validatedKey = this.idempotencyService.validateIdempotencyKey(meta.idempotencyKey);
    const payloadHash = this.idempotencyService.computePayloadHash(dto);

    if (validatedKey) {
      const check = await this.idempotencyService.checkOrLock(validatedKey, payloadHash);
      if (check.isCached && check.cachedResponse) {
        return { response: check.cachedResponse, isReplayed: true };
      }
    }

    // 4. Persistence
    const lead = await this.prisma.lead.create({
      data: {
        type: LeadType.CONTACT,
        name: dto.name,
        email: dto.email,
        schoolName: dto.schoolName,
        message: dto.topic ? `[Topic: ${dto.topic}] ${dto.message}` : dto.message,
        consentText: CONSENT_TEMPLATES.CONTACT,
        consentedAt: new Date(),
        ipAddressHash: this.hashIp(meta.ip),
        userAgent: meta.userAgent?.slice(0, 255),
        idempotencyKey: validatedKey,
        status: LeadStatus.NEW,
      },
    });

    const response: PublicLeadResponseDto = {
      id: lead.id,
      status: "received",
      message: "Inquiry received successfully",
      createdAt: lead.createdAt.toISOString(),
    };

    // 5. Store completed response in idempotency cache
    if (validatedKey) {
      await this.idempotencyService.storeResponse(validatedKey, payloadHash, response);
    }

    // 6. Asynchronous Notification dispatch
    await this.notificationService.enqueueNotification(lead.id);

    this.logger.log({
      event: "public_lead_registered",
      type: LeadType.CONTACT,
      leadId: lead.id,
    });

    return { response };
  }

  async submitDemo(dto: DemoLeadDto, meta: RequestClientMeta): Promise<SubmitResult> {
    // 1. Honeypot check
    const honeypotReceipt = this.checkHoneypot(dto.website_url, LeadType.DEMO);
    if (honeypotReceipt) {
      return { response: honeypotReceipt };
    }

    // 2. Spam verification (Turnstile)
    await this.spamService.verifyToken(dto.turnstileToken);

    // 3. Idempotency handling
    const validatedKey = this.idempotencyService.validateIdempotencyKey(meta.idempotencyKey);
    const payloadHash = this.idempotencyService.computePayloadHash(dto);

    if (validatedKey) {
      const check = await this.idempotencyService.checkOrLock(validatedKey, payloadHash);
      if (check.isCached && check.cachedResponse) {
        return { response: check.cachedResponse, isReplayed: true };
      }
    }

    // 4. Persistence
    const lead = await this.prisma.lead.create({
      data: {
        type: LeadType.DEMO,
        name: dto.name,
        email: dto.email,
        schoolName: dto.schoolName,
        message: dto.notes ? dto.notes : null,
        consentText: CONSENT_TEMPLATES.DEMO,
        consentedAt: new Date(),
        ipAddressHash: this.hashIp(meta.ip),
        userAgent: meta.userAgent?.slice(0, 255),
        idempotencyKey: validatedKey,
        status: LeadStatus.NEW,
      },
    });

    const response: PublicLeadResponseDto = {
      id: lead.id,
      status: "received",
      message: "Demo request received successfully",
      createdAt: lead.createdAt.toISOString(),
    };

    // 5. Store completed response in idempotency cache
    if (validatedKey) {
      await this.idempotencyService.storeResponse(validatedKey, payloadHash, response);
    }

    // 6. Asynchronous Notification dispatch
    await this.notificationService.enqueueNotification(lead.id);

    this.logger.log({
      event: "public_lead_registered",
      type: LeadType.DEMO,
      leadId: lead.id,
    });

    return { response };
  }

  async submitNewsletter(dto: NewsletterLeadDto, meta: RequestClientMeta): Promise<SubmitResult> {
    // 1. Honeypot check
    const honeypotReceipt = this.checkHoneypot(dto.website_url, LeadType.NEWSLETTER);
    if (honeypotReceipt) {
      return { response: honeypotReceipt };
    }

    // 2. Spam verification (Turnstile)
    await this.spamService.verifyToken(dto.turnstileToken);

    // 3. Idempotency handling
    const validatedKey = this.idempotencyService.validateIdempotencyKey(meta.idempotencyKey);
    const payloadHash = this.idempotencyService.computePayloadHash(dto);

    if (validatedKey) {
      const check = await this.idempotencyService.checkOrLock(validatedKey, payloadHash);
      if (check.isCached && check.cachedResponse) {
        return { response: check.cachedResponse, isReplayed: true };
      }
    }

    // 4. Persistence
    const lead = await this.prisma.lead.create({
      data: {
        type: LeadType.NEWSLETTER,
        email: dto.email,
        consentText: CONSENT_TEMPLATES.NEWSLETTER,
        consentedAt: new Date(),
        ipAddressHash: this.hashIp(meta.ip),
        userAgent: meta.userAgent?.slice(0, 255),
        idempotencyKey: validatedKey,
        status: LeadStatus.NEW,
      },
    });

    const response: PublicLeadResponseDto = {
      id: lead.id,
      status: "received",
      message: "Subscribed to updates successfully",
      createdAt: lead.createdAt.toISOString(),
    };

    // 5. Store completed response in idempotency cache
    if (validatedKey) {
      await this.idempotencyService.storeResponse(validatedKey, payloadHash, response);
    }

    // Newsletter never sends email notifications
    this.logger.log({
      event: "public_lead_registered",
      type: LeadType.NEWSLETTER,
      leadId: lead.id,
    });

    return { response };
  }
}
