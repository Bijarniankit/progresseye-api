import { Test, type TestingModule } from "@nestjs/testing";
import type { FastifyReply, FastifyRequest } from "fastify";
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

  const createMockReply = () => {
    const reply: Partial<FastifyReply> = {};
    reply.status = jest.fn().mockReturnValue(reply);
    reply.header = jest.fn().mockReturnValue(reply);
    reply.send = jest.fn().mockReturnValue(reply);
    return reply as FastifyReply;
  };

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

  it("delegates submitContact with extracted client metadata and idempotency key", async () => {
    const dto = {
      name: "Principal Sharma",
      email: "sharma@delhischool.edu.in",
      schoolName: "Delhi School",
      message: "Inquiry details here",
      consentGiven: true as const,
    };

    mockPublicLeadService.submitContact.mockResolvedValue({
      response: {
        id: "test-uuid",
        status: "received",
        message: "Inquiry received successfully",
        createdAt: "2026-10-24T10:00:00.000Z",
      },
      isReplayed: false,
    });

    const reply = createMockReply();
    await controller.submitContact(dto, mockRequest, reply, "550e8400-e29b-41d4-a716-446655440000");

    expect(reply.status).toHaveBeenCalledWith(201);
    expect(reply.send).toHaveBeenCalledWith(expect.objectContaining({ id: "test-uuid" }));
    expect(mockPublicLeadService.submitContact).toHaveBeenCalledWith(dto, {
      ip: "198.51.100.25",
      userAgent: "TestBrowser/1.0",
      idempotencyKey: "550e8400-e29b-41d4-a716-446655440000",
    });
  });

  it("attaches Idempotent-Replayed header when request is replayed", async () => {
    const dto = {
      name: "Principal Sharma",
      email: "sharma@delhischool.edu.in",
      schoolName: "Delhi School",
      message: "Inquiry details here",
      consentGiven: true as const,
    };

    mockPublicLeadService.submitContact.mockResolvedValue({
      response: {
        id: "test-uuid",
        status: "received",
        message: "Inquiry received successfully",
        createdAt: "2026-10-24T10:00:00.000Z",
      },
      isReplayed: true,
    });

    const reply = createMockReply();
    await controller.submitContact(dto, mockRequest, reply, "550e8400-e29b-41d4-a716-446655440000");

    expect(reply.header).toHaveBeenCalledWith("Idempotent-Replayed", "true");
    expect(reply.status).toHaveBeenCalledWith(201);
  });

  it("delegates submitDemo with extracted client metadata", async () => {
    const dto = {
      name: "Vice Principal Verma",
      email: "verma@school.edu.in",
      schoolName: "Model School",
      consentGiven: true as const,
    };

    mockPublicLeadService.submitDemo.mockResolvedValue({
      response: {
        id: "test-uuid-demo",
        status: "received",
        message: "Demo request received successfully",
        createdAt: "2026-10-24T10:00:00.000Z",
      },
    });

    const reply = createMockReply();
    await controller.submitDemo(dto, mockRequest, reply);

    expect(reply.status).toHaveBeenCalledWith(201);
    expect(reply.send).toHaveBeenCalledWith(expect.objectContaining({ id: "test-uuid-demo" }));
  });

  it("delegates submitNewsletter with extracted client metadata", async () => {
    const dto = {
      email: "subscriber@edu.in",
      consentGiven: true as const,
    };

    mockPublicLeadService.submitNewsletter.mockResolvedValue({
      response: {
        id: "test-uuid-newsletter",
        status: "received",
        message: "Subscribed to updates successfully",
        createdAt: "2026-10-24T10:00:00.000Z",
      },
    });

    const reply = createMockReply();
    await controller.submitNewsletter(dto, mockRequest, reply);

    expect(reply.status).toHaveBeenCalledWith(201);
    expect(reply.send).toHaveBeenCalledWith(
      expect.objectContaining({ id: "test-uuid-newsletter" }),
    );
  });
});
