import * as crypto from "node:crypto";
import { BadRequestException, Injectable, Logger } from "@nestjs/common";
import { LeadStatus, LeadType } from "@prisma/client";
import { PrismaService } from "../../../infra/prisma/prisma.service";
import { CONSENT_TEMPLATES } from "../domain/consent-templates";
import type { ContactLeadDto, DemoLeadDto, NewsletterLeadDto, PublicLeadResponseDto } from "../dto";

export interface RequestClientMeta {
  ip?: string;
  userAgent?: string;
}

@Injectable()
export class PublicLeadService {
  private readonly logger = new Logger(PublicLeadService.name);

  constructor(private readonly prisma: PrismaService) {}

  private hashIp(ip?: string): string | undefined {
    if (!ip) return undefined;
    return crypto.createHash("sha256").update(`${ip}:progresseye-lead-salt`).digest("hex");
  }

  private verifyHoneypot(honeypotValue?: string): void {
    if (honeypotValue && honeypotValue.trim().length > 0) {
      this.logger.warn("Bot submission detected via honeypot field");
      throw new BadRequestException("Invalid submission");
    }
  }

  async submitContact(
    dto: ContactLeadDto,
    meta: RequestClientMeta,
  ): Promise<PublicLeadResponseDto> {
    this.verifyHoneypot(dto.website_url);

    const lead = await this.prisma.lead.create({
      data: {
        type: LeadType.CONTACT,
        name: dto.name,
        email: dto.email.toLowerCase(),
        schoolName: dto.schoolName,
        message: dto.message,
        consentText: CONSENT_TEMPLATES.CONTACT,
        consentedAt: new Date(),
        ipAddressHash: this.hashIp(meta.ip),
        userAgent: meta.userAgent?.slice(0, 255),
        status: LeadStatus.NEW,
      },
    });

    this.logger.log(`Public contact lead registered [id=${lead.id}]`);

    return {
      id: lead.id,
      status: "received",
      message: "Inquiry received successfully",
      createdAt: lead.createdAt.toISOString(),
    };
  }

  async submitDemo(dto: DemoLeadDto, meta: RequestClientMeta): Promise<PublicLeadResponseDto> {
    this.verifyHoneypot(dto.website_url);

    const notesSummary = [
      dto.notes,
      dto.preferredTime ? `Preferred time: ${dto.preferredTime}` : undefined,
    ]
      .filter(Boolean)
      .join(" | ");

    const lead = await this.prisma.lead.create({
      data: {
        type: LeadType.DEMO,
        name: dto.name,
        email: dto.email.toLowerCase(),
        schoolName: dto.schoolName,
        message: notesSummary.length > 0 ? notesSummary : null,
        consentText: CONSENT_TEMPLATES.DEMO,
        consentedAt: new Date(),
        ipAddressHash: this.hashIp(meta.ip),
        userAgent: meta.userAgent?.slice(0, 255),
        status: LeadStatus.NEW,
      },
    });

    this.logger.log(`Public demo lead registered [id=${lead.id}]`);

    return {
      id: lead.id,
      status: "received",
      message: "Demo request received successfully",
      createdAt: lead.createdAt.toISOString(),
    };
  }

  async submitNewsletter(
    dto: NewsletterLeadDto,
    meta: RequestClientMeta,
  ): Promise<PublicLeadResponseDto> {
    this.verifyHoneypot(dto.website_url);

    const lead = await this.prisma.lead.create({
      data: {
        type: LeadType.NEWSLETTER,
        email: dto.email.toLowerCase(),
        consentText: CONSENT_TEMPLATES.NEWSLETTER,
        consentedAt: new Date(),
        ipAddressHash: this.hashIp(meta.ip),
        userAgent: meta.userAgent?.slice(0, 255),
        status: LeadStatus.NEW,
      },
    });

    this.logger.log(`Public newsletter subscription registered [id=${lead.id}]`);

    return {
      id: lead.id,
      status: "received",
      message: "Subscribed to updates successfully",
      createdAt: lead.createdAt.toISOString(),
    };
  }
}
