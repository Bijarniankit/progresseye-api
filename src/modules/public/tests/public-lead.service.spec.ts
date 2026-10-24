import { BadRequestException } from "@nestjs/common";
import { Test, type TestingModule } from "@nestjs/testing";
import { LeadStatus, LeadType } from "@prisma/client";
import { AppConfigService } from "../../../config/config.service";
import { PrismaService } from "../../../infra/prisma/prisma.service";
import { PublicLeadService } from "../application/public-lead.service";
import { IdempotencyService } from "../domain/anti-abuse/idempotency.service";
import { SPAM_VERIFICATION_SERVICE } from "../domain/anti-abuse/spam-verification.service";
import { LeadNotificationService } from "../domain/notification/lead-notification.service";

describe("PublicLeadService", () => {
  let service: PublicLeadService;

  const mockPrismaService = {
    lead: {
      create: jest.fn(),
      findUnique: jest.fn(),
    },
  };

  const mockConfigService = {
    get: jest.fn((key: string) => {
      if (key === "LEAD_IP_HMAC_SECRET") return "test-hmac-secret-123";
      return undefined;
    }),
  };

  const mockIdempotencyService = {
    validateIdempotencyKey: jest.fn((key) => key),
    computePayloadHash: jest.fn(() => "mock-payload-hash"),
    checkOrLock: jest.fn().mockResolvedValue({ isCached: false }),
    storeResponse: jest.fn().mockResolvedValue(undefined),
  };

  const mockNotificationService = {
    enqueueNotification: jest.fn().mockResolvedValue(undefined),
  };

  const mockSpamService = {
    verifyToken: jest.fn().mockResolvedValue({ success: true }),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PublicLeadService,
        { provide: PrismaService, useValue: mockPrismaService },
        { provide: AppConfigService, useValue: mockConfigService },
        { provide: IdempotencyService, useValue: mockIdempotencyService },
        { provide: LeadNotificationService, useValue: mockNotificationService },
        { provide: SPAM_VERIFICATION_SERVICE, useValue: mockSpamService },
      ],
    }).compile();

    service = module.get<PublicLeadService>(PublicLeadService);
    jest.clearAllMocks();
  });

  describe("Honeypot Protection", () => {
    it("returns ordinary 201 receipt and discards payload without saving to DB or sending notification when honeypot is triggered", async () => {
      const dto = {
        name: "Bot User",
        email: "bot@example.com",
        schoolName: "Spam School",
        message: "Spam message buy viagra",
        consentGiven: true as const,
        website_url: "http://spam-link.example",
      };

      const result = await service.submitContact(dto, { ip: "1.2.3.4" });

      expect(result.response.status).toBe("received");
      expect(result.response.id).toBeDefined();
      expect(mockPrismaService.lead.create).not.toHaveBeenCalled();
      expect(mockNotificationService.enqueueNotification).not.toHaveBeenCalled();
      expect(mockSpamService.verifyToken).not.toHaveBeenCalled();
    });
  });

  describe("Spam Verification (Turnstile)", () => {
    it("throws BadRequestException when spam verification fails", async () => {
      mockSpamService.verifyToken.mockRejectedValueOnce(
        new BadRequestException("Spam verification failed"),
      );

      const dto = {
        name: "Suspicious User",
        email: "suspicious@example.com",
        schoolName: "Test School",
        message: "Legitimate inquiry text",
        consentGiven: true as const,
        turnstileToken: "invalid-token",
      };

      await expect(service.submitContact(dto, { ip: "1.2.3.4" })).rejects.toThrow(
        BadRequestException,
      );
      expect(mockPrismaService.lead.create).not.toHaveBeenCalled();
    });
  });

  describe("Idempotency Handling", () => {
    it("returns cached response without creating a new database record when request is replayed", async () => {
      const cachedResponse = {
        id: "existing-uuid",
        status: "received" as const,
        message: "Inquiry received successfully",
        createdAt: "2026-10-24T10:00:00.000Z",
      };

      mockIdempotencyService.checkOrLock.mockResolvedValueOnce({
        isCached: true,
        cachedResponse,
      });

      const dto = {
        name: "Dr. Sharma",
        email: "sharma@school.edu.in",
        schoolName: "Delhi Public School",
        message: "Inquiry details",
        consentGiven: true as const,
      };

      const result = await service.submitContact(dto, {
        ip: "1.2.3.4",
        idempotencyKey: "550e8400-e29b-41d4-a716-446655440000",
      });

      expect(result.isReplayed).toBe(true);
      expect(result.response).toEqual(cachedResponse);
      expect(mockPrismaService.lead.create).not.toHaveBeenCalled();
    });

    it("persists lead and stores response in idempotency cache on first attempt", async () => {
      const mockLead = {
        id: "new-lead-uuid",
        type: LeadType.CONTACT,
        name: "Dr. Sharma",
        email: "sharma@school.edu.in",
        schoolName: "Delhi Public School",
        message: "Inquiry details",
        consentText: "Contact Consent",
        consentedAt: new Date("2026-10-24T10:00:00.000Z"),
        createdAt: new Date("2026-10-24T10:00:00.000Z"),
        status: LeadStatus.NEW,
      };

      mockPrismaService.lead.create.mockResolvedValueOnce(mockLead);

      const dto = {
        name: "Dr. Sharma",
        email: "sharma@school.edu.in",
        schoolName: "Delhi Public School",
        message: "Inquiry details",
        consentGiven: true as const,
      };

      const result = await service.submitContact(dto, {
        ip: "198.51.100.5",
        idempotencyKey: "550e8400-e29b-41d4-a716-446655440000",
      });

      expect(result.isReplayed).toBeFalsy();
      expect(result.response.id).toBe("new-lead-uuid");
      expect(mockPrismaService.lead.create).toHaveBeenCalled();
      expect(mockIdempotencyService.storeResponse).toHaveBeenCalledWith(
        "550e8400-e29b-41d4-a716-446655440000",
        "mock-payload-hash",
        expect.objectContaining({ id: "new-lead-uuid" }),
      );
      expect(mockNotificationService.enqueueNotification).toHaveBeenCalledWith("new-lead-uuid");
    });
  });

  describe("HMAC IP Protection", () => {
    it("hashes IP using HMAC secret rather than storing raw IP", async () => {
      const mockLead = {
        id: "ip-test-uuid",
        createdAt: new Date(),
        status: LeadStatus.NEW,
      };
      mockPrismaService.lead.create.mockResolvedValueOnce(mockLead);

      const dto = {
        email: "newsletter@school.edu.in",
        consentGiven: true as const,
      };

      await service.submitNewsletter(dto, { ip: "203.0.113.195" });

      expect(mockPrismaService.lead.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            ipAddressHash: expect.stringMatching(/^[0-9a-f]{64}$/),
          }),
        }),
      );

      // Verify raw IP is never passed to Prisma
      const createCall = mockPrismaService.lead.create.mock.calls[0][0];
      expect(createCall.data.ipAddressHash).not.toContain("203.0.113.195");
    });
  });
});
