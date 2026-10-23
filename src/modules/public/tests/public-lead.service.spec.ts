import { BadRequestException } from "@nestjs/common";
import { Test, type TestingModule } from "@nestjs/testing";
import { LeadStatus, LeadType } from "@prisma/client";
import { PrismaService } from "../../../infra/prisma/prisma.service";
import { PublicLeadService } from "../application/public-lead.service";
import { CONSENT_TEMPLATES } from "../domain/consent-templates";

describe("PublicLeadService", () => {
  let service: PublicLeadService;

  const mockPrismaService = {
    lead: {
      create: jest.fn(),
    },
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PublicLeadService,
        {
          provide: PrismaService,
          useValue: mockPrismaService,
        },
      ],
    }).compile();

    service = module.get<PublicLeadService>(PublicLeadService);
    jest.clearAllMocks();
  });

  describe("submitContact", () => {
    it("successfully creates a CONTACT lead with hashed IP and lowercase email", async () => {
      const mockLead = {
        id: "123e4567-e89b-12d3-a456-426614174000",
        type: LeadType.CONTACT,
        name: "Principal Rao",
        email: "principal@school.edu.in",
        schoolName: "National Academy",
        message: "Need information on school onboarding.",
        status: LeadStatus.NEW,
        consentText: CONSENT_TEMPLATES.CONTACT,
        consentedAt: new Date(),
        createdAt: new Date("2026-10-24T10:00:00.000Z"),
        updatedAt: new Date("2026-10-24T10:00:00.000Z"),
      };

      (mockPrismaService.lead.create as jest.Mock).mockResolvedValue(mockLead);

      const result = await service.submitContact(
        {
          name: "Principal Rao",
          email: "Principal@School.EDU.IN",
          schoolName: "National Academy",
          message: "Need information on school onboarding.",
          consentGiven: true,
        },
        { ip: "203.0.113.195", userAgent: "Mozilla/5.0" },
      );

      expect(result).toEqual({
        id: mockLead.id,
        status: "received",
        message: "Inquiry received successfully",
        createdAt: "2026-10-24T10:00:00.000Z",
      });

      expect(mockPrismaService.lead.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          type: LeadType.CONTACT,
          name: "Principal Rao",
          email: "principal@school.edu.in",
          schoolName: "National Academy",
          status: LeadStatus.NEW,
          consentText: CONSENT_TEMPLATES.CONTACT,
          ipAddressHash: expect.any(String),
          userAgent: "Mozilla/5.0",
        }),
      });

      // Assert IP was hashed and is not raw
      const createCall = (mockPrismaService.lead.create as jest.Mock).mock.calls[0][0];
      expect(createCall.data.ipAddressHash).not.toBe("203.0.113.195");
      expect(createCall.data.ipAddressHash).toHaveLength(64); // SHA-256 hex
    });

    it("rejects bot submissions when honeypot field is populated", async () => {
      await expect(
        service.submitContact(
          {
            name: "Bot Spammer",
            email: "bot@spam.com",
            schoolName: "Fake School",
            message: "Buy cheap crypto",
            consentGiven: true,
            website_url: "http://spam.ru",
          },
          { ip: "198.51.100.1" },
        ),
      ).rejects.toThrow(BadRequestException);

      expect(mockPrismaService.lead.create).not.toHaveBeenCalled();
    });
  });

  describe("submitDemo", () => {
    it("successfully creates a DEMO lead bundling notes and preferredTime", async () => {
      const mockLead = {
        id: "223e4567-e89b-12d3-a456-426614174001",
        type: LeadType.DEMO,
        name: "Dean Verma",
        email: "dean@apex.edu.in",
        schoolName: "Apex High School",
        message: "Looking for ERP replacement | Preferred time: Afternoon",
        status: LeadStatus.NEW,
        consentText: CONSENT_TEMPLATES.DEMO,
        consentedAt: new Date(),
        createdAt: new Date("2026-10-24T11:00:00.000Z"),
        updatedAt: new Date("2026-10-24T11:00:00.000Z"),
      };

      (mockPrismaService.lead.create as jest.Mock).mockResolvedValue(mockLead);

      const result = await service.submitDemo(
        {
          name: "Dean Verma",
          email: "dean@apex.edu.in",
          schoolName: "Apex High School",
          notes: "Looking for ERP replacement",
          preferredTime: "Afternoon",
          consentGiven: true,
        },
        { ip: "192.0.2.1" },
      );

      expect(result.id).toBe(mockLead.id);
      expect(mockPrismaService.lead.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          type: LeadType.DEMO,
          message: "Looking for ERP replacement | Preferred time: Afternoon",
          consentText: CONSENT_TEMPLATES.DEMO,
        }),
      });
    });
  });

  describe("submitNewsletter", () => {
    it("successfully creates a NEWSLETTER lead with minimal fields", async () => {
      const mockLead = {
        id: "333e4567-e89b-12d3-a456-426614174002",
        type: LeadType.NEWSLETTER,
        email: "subscriber@school.edu.in",
        status: LeadStatus.NEW,
        consentText: CONSENT_TEMPLATES.NEWSLETTER,
        consentedAt: new Date(),
        createdAt: new Date("2026-10-24T12:00:00.000Z"),
        updatedAt: new Date("2026-10-24T12:00:00.000Z"),
      };

      (mockPrismaService.lead.create as jest.Mock).mockResolvedValue(mockLead);

      const result = await service.submitNewsletter(
        {
          email: "subscriber@school.edu.in",
          consentGiven: true,
        },
        { ip: "192.0.2.10" },
      );

      expect(result.id).toBe(mockLead.id);
      expect(mockPrismaService.lead.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          type: LeadType.NEWSLETTER,
          email: "subscriber@school.edu.in",
          consentText: CONSENT_TEMPLATES.NEWSLETTER,
        }),
      });
    });
  });
});
