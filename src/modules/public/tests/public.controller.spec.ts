import { Test, type TestingModule } from "@nestjs/testing";
import type { FastifyRequest } from "fastify";
import { PublicLeadService } from "../application/public-lead.service";
import { PublicController } from "../http/public.controller";

describe("PublicController", () => {
  let controller: PublicController;

  const mockPublicLeadService = {
    submitContact: jest.fn(),
    submitDemo: jest.fn(),
    submitNewsletter: jest.fn(),
  };

  const mockRequest = {
    ip: "198.51.100.25",
    headers: {
      "user-agent": "TestBrowser/1.0",
    },
  } as unknown as FastifyRequest;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [PublicController],
      providers: [
        {
          provide: PublicLeadService,
          useValue: mockPublicLeadService,
        },
      ],
    }).compile();

    controller = module.get<PublicController>(PublicController);
    jest.clearAllMocks();
  });

  it("delegates submitContact with extracted client metadata", async () => {
    const dto = {
      name: "Principal Sharma",
      email: "sharma@delhischool.edu.in",
      schoolName: "Delhi School",
      message: "Inquiry details here",
      consentGiven: true as const,
    };

    mockPublicLeadService.submitContact.mockResolvedValue({
      id: "test-uuid",
      status: "received",
      message: "Inquiry received successfully",
      createdAt: "2026-10-24T10:00:00.000Z",
    });

    const result = await controller.submitContact(dto, mockRequest);
    expect(result.id).toBe("test-uuid");
    expect(mockPublicLeadService.submitContact).toHaveBeenCalledWith(dto, {
      ip: "198.51.100.25",
      userAgent: "TestBrowser/1.0",
    });
  });

  it("delegates submitDemo with extracted client metadata", async () => {
    const dto = {
      name: "Dean Gupta",
      email: "gupta@delhischool.edu.in",
      schoolName: "Delhi School",
      notes: "Demo notes",
      preferredTime: "Morning",
      consentGiven: true as const,
    };

    mockPublicLeadService.submitDemo.mockResolvedValue({
      id: "demo-uuid",
      status: "received",
      message: "Demo request received successfully",
      createdAt: "2026-10-24T10:00:00.000Z",
    });

    const result = await controller.submitDemo(dto, mockRequest);
    expect(result.id).toBe("demo-uuid");
    expect(mockPublicLeadService.submitDemo).toHaveBeenCalledWith(dto, {
      ip: "198.51.100.25",
      userAgent: "TestBrowser/1.0",
    });
  });

  it("delegates submitNewsletter with extracted client metadata", async () => {
    const dto = {
      email: "news@delhischool.edu.in",
      consentGiven: true as const,
    };

    mockPublicLeadService.submitNewsletter.mockResolvedValue({
      id: "news-uuid",
      status: "received",
      message: "Subscribed to updates successfully",
      createdAt: "2026-10-24T10:00:00.000Z",
    });

    const result = await controller.submitNewsletter(dto, mockRequest);
    expect(result.id).toBe("news-uuid");
    expect(mockPublicLeadService.submitNewsletter).toHaveBeenCalledWith(dto, {
      ip: "198.51.100.25",
      userAgent: "TestBrowser/1.0",
    });
  });
});
