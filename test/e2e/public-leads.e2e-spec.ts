import { Writable } from "node:stream";
import { BadRequestException } from "@nestjs/common";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { Test, type TestingModule } from "@nestjs/testing";
import { type Lead, LeadStatus, LeadType, type Prisma } from "@prisma/client";

import request = require("supertest");

import { AppModule } from "../../src/app.module";
import { ErrorCode } from "../../src/common/errors/error-codes.enum";
import { PrismaService } from "../../src/infra/prisma/prisma.service";
import {
  SPAM_VERIFICATION_SERVICE,
  TurnstileService,
} from "../../src/modules/public/domain/anti-abuse/spam-verification.service";

jest.setTimeout(30000);

describe("Public Leads API E2E Tests", () => {
  let app: NestFastifyApplication;
  let prismaService: PrismaService;
  const testLogBuffer: string[] = [];

  beforeAll(async () => {
    process.env.DATABASE_URL = "postgresql://postgres:postgrespassword@localhost:5432/test_db";
    process.env.THROTTLE_LIMIT = "100";
    process.env.THROTTLE_TTL = "60000";

    // Route Pino logs to in-memory test stream for assertion verification
    (globalThis as unknown as { __PINO_TEST_STREAM__: Writable }).__PINO_TEST_STREAM__ =
      new Writable({
        write(chunk, _enc, cb) {
          testLogBuffer.push(chunk.toString());
          cb();
        },
      });

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication<NestFastifyApplication>(
      new FastifyAdapter({ trustProxy: true, bodyLimit: 16 * 1024 }),
    );
    app.setGlobalPrefix("/api/v1");

    prismaService = moduleFixture.get<PrismaService>(PrismaService);

    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(prismaService.lead, "findUnique").mockResolvedValue(null);
    jest.spyOn(prismaService.lead, "update").mockResolvedValue(null as never);
  });

  afterAll(async () => {
    delete (globalThis as unknown as { __PINO_TEST_STREAM__?: Writable }).__PINO_TEST_STREAM__;
    if (app) {
      await app.close();
    }
  });

  describe("POST /api/v1/public/contact", () => {
    it("returns HTTP 201 with opaque receipt on valid contact inquiry", async () => {
      const mockLead = {
        id: "a0000000-0000-0000-0000-000000000001",
        type: LeadType.CONTACT,
        name: "Principal Sharma",
        email: "principal@dps.edu.in",
        schoolName: "Delhi Public School",
        message: "We would like to discuss campus management features.",
        status: LeadStatus.NEW,
        consentText: "Consent text",
        consentedAt: new Date(),
        createdAt: new Date("2026-10-24T10:00:00.000Z"),
        updatedAt: new Date("2026-10-24T10:00:00.000Z"),
      };

      jest.spyOn(prismaService.lead, "create").mockResolvedValueOnce(mockLead as never);

      const response = await request(app.getHttpServer())
        .post("/api/v1/public/contact")
        .set("Content-Type", "application/json")
        .set("X-Forwarded-For", "198.51.100.1")
        .send({
          name: "Principal Sharma",
          email: "principal@dps.edu.in",
          schoolName: "Delhi Public School",
          message: "We would like to discuss campus management features.",
          consentGiven: true,
        })
        .expect(201);

      expect(response.body).toEqual({
        id: mockLead.id,
        status: "received",
        message: "Inquiry received successfully",
        createdAt: "2026-10-24T10:00:00.000Z",
      });
    });

    it("returns RFC 9457 Problem Details 400 when validation fails", async () => {
      const response = await request(app.getHttpServer())
        .post("/api/v1/public/contact")
        .set("Content-Type", "application/json")
        .set("X-Forwarded-For", "198.51.100.2")
        .send({
          name: "P", // too short (min 2)
          email: "not-an-email",
          schoolName: "",
          message: "short", // too short (min 10)
          consentGiven: false,
        })
        .expect(400);

      expect(response.headers["content-type"]).toContain("application/problem+json");
      expect(response.body).toHaveProperty("code", "VALIDATION_ERROR");
      expect(response.body).toHaveProperty("status", 400);
      expect(response.body).toHaveProperty("invalidParams");
      expect(Array.isArray(response.body.invalidParams)).toBe(true);
    });

    it("returns ordinary 201 receipt and discards without saving when honeypot is populated", async () => {
      const createSpy = jest.spyOn(prismaService.lead, "create");

      const response = await request(app.getHttpServer())
        .post("/api/v1/public/contact")
        .set("Content-Type", "application/json")
        .set("X-Forwarded-For", "198.51.100.3")
        .send({
          name: "Bot Spammer",
          email: "bot@spammer.org",
          schoolName: "Spam School",
          message: "Buy cheap backlinks now for education websites!",
          consentGiven: true,
          website_url: "https://spam.example.com",
        })
        .expect(201);

      expect(response.body.status).toBe("received");
      expect(response.body.id).toBeDefined();
      expect(createSpy).not.toHaveBeenCalled();
    });

    it("rejects unknown fields with 400 Problem Details (strict schema enforcement)", async () => {
      const response = await request(app.getHttpServer())
        .post("/api/v1/public/contact")
        .set("Content-Type", "application/json")
        .set("X-Forwarded-For", "198.51.100.4")
        .send({
          name: "Principal Sharma",
          email: "principal@dps.edu.in",
          schoolName: "Delhi Public School",
          message: "Inquiry details here for testing strict schema",
          consentGiven: true,
          maliciousInjectedField: "injected",
        })
        .expect(400);

      expect(response.headers["content-type"]).toContain("application/problem+json");
      expect(response.body).toHaveProperty("code", "VALIDATION_ERROR");
    });

    it("returns 400 with machine-readable code SPAM_VERIFICATION_FAILED when spam verification fails", async () => {
      const spamService = app.get<TurnstileService>(SPAM_VERIFICATION_SERVICE);
      jest.spyOn(spamService, "verifyToken").mockRejectedValueOnce(
        new BadRequestException({
          code: ErrorCode.SPAM_VERIFICATION_FAILED,
          message: "Spam verification failed",
        }),
      );

      const response = await request(app.getHttpServer())
        .post("/api/v1/public/contact")
        .set("Content-Type", "application/json")
        .send({
          name: "Dr. Test",
          email: "test@school.edu.in",
          schoolName: "Test School",
          message: "Inquiry message for spam testing",
          consentGiven: true,
          turnstileToken: "invalid-token",
        })
        .expect(400);

      expect(response.headers["content-type"]).toContain("application/problem+json");
      expect(response.body).toHaveProperty("code", "SPAM_VERIFICATION_FAILED");
      expect(response.body).toHaveProperty("title", "Bad Request");
      expect(response.body).toHaveProperty(
        "type",
        "https://api.progresseye.com/errors/SPAM_VERIFICATION_FAILED",
      );
    });

    it("rejects non-JSON Content-Type with 400 Problem Details", async () => {
      const response = await request(app.getHttpServer())
        .post("/api/v1/public/contact")
        .set("Content-Type", "text/plain")
        .set("X-Forwarded-For", "198.51.100.5")
        .send("plain text body")
        .expect(400);

      expect(response.headers["content-type"]).toContain("application/problem+json");
      expect(response.body.detail).toContain("Content-Type must be application/json");
    });

    it("rejects request bodies larger than 16 kB with 413 Problem Details", async () => {
      const largePayload = {
        name: "Principal Sharma",
        email: "principal@dps.edu.in",
        schoolName: "Delhi Public School",
        message: "A".repeat(17 * 1024),
        consentGiven: true,
      };

      const response = await request(app.getHttpServer())
        .post("/api/v1/public/contact")
        .set("Content-Type", "application/json")
        .set("X-Forwarded-For", "198.51.100.55")
        .send(largePayload)
        .expect(413);

      expect(response.headers["content-type"]).toContain("application/problem+json");
      expect(response.body).toHaveProperty("code", "PAYLOAD_TOO_LARGE");
      expect(response.body.status).toBe(413);
    });

    it("handles idempotency: returns cached response on replay with Idempotent-Replayed header", async () => {
      const idempotencyKey = "550e8400-e29b-41d4-a716-446655440099";
      const mockLead = {
        id: "a0000000-0000-0000-0000-000000000099",
        type: LeadType.CONTACT,
        name: "Principal Sharma",
        email: "sharma@idempotent.edu.in",
        schoolName: "Idempotent School",
        message: "First inquiry submission test message",
        status: LeadStatus.NEW,
        consentText: "Consent text",
        consentedAt: new Date(),
        createdAt: new Date("2026-10-24T10:00:00.000Z"),
        updatedAt: new Date("2026-10-24T10:00:00.000Z"),
      };

      jest.spyOn(prismaService.lead, "create").mockResolvedValueOnce(mockLead as never);

      const payload = {
        name: "Principal Sharma",
        email: "sharma@idempotent.edu.in",
        schoolName: "Idempotent School",
        message: "First inquiry submission test message",
        consentGiven: true,
      };

      // 1. Initial request from isolated IP
      const res1 = await request(app.getHttpServer())
        .post("/api/v1/public/contact")
        .set("Content-Type", "application/json")
        .set("X-Forwarded-For", "198.51.100.6")
        .set("Idempotency-Key", idempotencyKey)
        .send(payload)
        .expect(201);

      expect(res1.body.id).toBe(mockLead.id);

      // 2. Exact duplicate request with same idempotency key
      const res2 = await request(app.getHttpServer())
        .post("/api/v1/public/contact")
        .set("Content-Type", "application/json")
        .set("X-Forwarded-For", "198.51.100.6")
        .set("Idempotency-Key", idempotencyKey)
        .send(payload)
        .expect(201);

      expect(res2.headers["idempotent-replayed"]).toBe("true");
      expect(res2.body.id).toBe(mockLead.id);

      // 3. Different payload with same idempotency key returns 422
      const res3 = await request(app.getHttpServer())
        .post("/api/v1/public/contact")
        .set("Content-Type", "application/json")
        .set("X-Forwarded-For", "198.51.100.6")
        .set("Idempotency-Key", idempotencyKey)
        .send({
          ...payload,
          name: "Different Name",
        })
        .expect(422);

      expect(res3.headers["content-type"]).toContain("application/problem+json");
      expect(res3.body.code).toBe("UNPROCESSABLE_ENTITY");
    });
  });

  describe("POST /api/v1/public/demo", () => {
    it("returns HTTP 201 on valid demo request", async () => {
      const mockLead = {
        id: "b0000000-0000-0000-0000-000000000002",
        type: LeadType.DEMO,
        name: "Dean K. Patel",
        email: "patel@vidyamandir.edu.in",
        schoolName: "Vidya Mandir School",
        message: "Looking for attendance module",
        status: LeadStatus.NEW,
        consentText: "Consent text",
        consentedAt: new Date(),
        createdAt: new Date("2026-10-24T11:00:00.000Z"),
        updatedAt: new Date("2026-10-24T11:00:00.000Z"),
      };

      jest.spyOn(prismaService.lead, "create").mockResolvedValueOnce(mockLead as never);

      const response = await request(app.getHttpServer())
        .post("/api/v1/public/demo")
        .set("Content-Type", "application/json")
        .set("X-Forwarded-For", "198.51.100.7")
        .send({
          name: "Dean K. Patel",
          email: "patel@vidyamandir.edu.in",
          schoolName: "Vidya Mandir School",
          notes: "Looking for attendance module",
          consentGiven: true,
        })
        .expect(201);

      expect(response.body).toEqual({
        id: mockLead.id,
        status: "received",
        message: "Demo request received successfully",
        createdAt: "2026-10-24T11:00:00.000Z",
      });
    });
  });

  describe("POST /api/v1/public/newsletter", () => {
    it("returns HTTP 201 on valid newsletter subscription", async () => {
      const mockLead = {
        id: "c0000000-0000-0000-0000-000000000003",
        type: LeadType.NEWSLETTER,
        email: "updates@school.edu.in",
        status: LeadStatus.NEW,
        consentText: "Consent text",
        consentedAt: new Date(),
        createdAt: new Date("2026-10-24T12:00:00.000Z"),
        updatedAt: new Date("2026-10-24T12:00:00.000Z"),
      };

      jest.spyOn(prismaService.lead, "create").mockResolvedValueOnce(mockLead as never);

      const response = await request(app.getHttpServer())
        .post("/api/v1/public/newsletter")
        .set("Content-Type", "application/json")
        .set("X-Forwarded-For", "198.51.100.8")
        .send({
          email: "updates@school.edu.in",
          consentGiven: true,
        })
        .expect(201);

      expect(response.body).toEqual({
        id: mockLead.id,
        status: "received",
        message: "Subscribed to updates successfully",
        createdAt: "2026-10-24T12:00:00.000Z",
      });
    });
  });

  describe("Mailpit SMTP Verification (in CI Service Container)", () => {
    it("POSTs a lead, processes asynchronous BullMQ notification, and verifies email delivery in Mailpit", async () => {
      // 1. In CI, Mailpit MUST be accessible, otherwise fail fast
      let isMailpitUp = false;
      try {
        const ping = await fetch("http://localhost:8025/api/v1/messages", {
          signal: AbortSignal.timeout(2000),
        });
        isMailpitUp = ping.ok;
      } catch {
        isMailpitUp = false;
      }

      if (process.env.CI && !isMailpitUp) {
        throw new Error(
          "Mailpit service container is required in CI but unreachable on http://localhost:8025",
        );
      }

      if (!isMailpitUp) {
        console.log(
          "Local environment without Docker: Mailpit service container unavailable; integration assertions verified in GitHub Actions CI",
        );
        return;
      }

      // Check whether real database is accessible
      let dbConnected = false;
      try {
        await prismaService.$queryRaw`SELECT 1`;
        dbConnected = true;
      } catch {
        dbConnected = false;
      }

      let testLead: Lead | null = null;
      if (dbConnected) {
        // Restore prisma spies so real database persistence and update happen
        (prismaService.lead.create as jest.Mock)?.mockRestore?.();
        (prismaService.lead.findUnique as jest.Mock)?.mockRestore?.();
        (prismaService.lead.update as jest.Mock)?.mockRestore?.();
      } else {
        // In local mock mode with Mailpit running
        (prismaService.lead.create as jest.Mock).mockImplementation(
          async ({ data }: { data: Prisma.LeadCreateInput }) => {
            testLead = {
              id: "b1000000-0000-0000-0000-000000000001",
              ...data,
              createdAt: new Date(),
              updatedAt: new Date(),
            } as Lead;
            return testLead;
          },
        );
        (prismaService.lead.findUnique as jest.Mock).mockImplementation(
          async ({ where }: { where: { id: string } }) => {
            return testLead?.id === where.id ? testLead : null;
          },
        );
        (prismaService.lead.update as jest.Mock).mockImplementation(
          async ({ where, data }: { where: { id: string }; data: Prisma.LeadUpdateInput }) => {
            if (testLead?.id === where.id) {
              testLead = { ...testLead, ...data } as Lead;
            }
            return testLead;
          },
        );
      }

      // 2. Submit a lead via HTTP POST
      const leadPayload = {
        name: "Principal Rao",
        email: "principal.rao@vidyamandir.edu.in",
        schoolName: "Vidya Mandir Public School",
        message: "Detailed demonstration request for student attendance tracking.",
        consentGiven: true,
      };

      const postResponse = await request(app.getHttpServer())
        .post("/api/v1/public/contact")
        .set("Content-Type", "application/json")
        .set("X-Forwarded-For", "198.51.100.99")
        .send(leadPayload)
        .expect(201);

      expect(postResponse.body).toHaveProperty("id");
      expect(postResponse.body).toHaveProperty("status", "received");
      const createdLeadId = postResponse.body.id;

      // 3. Poll Mailpit HTTP API (localhost:8025) until email appears
      const shortId = createdLeadId.slice(0, 8);
      const expectedSubject = `ProgressEye: new lead received (Ref: ${shortId})`;
      const subjectPattern = /^ProgressEye: new lead received \(Ref: [a-f0-9]{8}\)$/;

      let deliveredMessage: { ID: string; Subject: string } | null = null;
      for (let attempt = 0; attempt < 20; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 500));
        const res = await fetch("http://localhost:8025/api/v1/messages");
        if (res.ok) {
          const body = (await res.json()) as { messages?: Array<{ ID: string; Subject: string }> };
          deliveredMessage =
            (body.messages || []).find((m) => m.Subject === expectedSubject) ?? null;
          if (deliveredMessage) break;
        }
      }

      // 4. Assertions on the delivered email
      expect(deliveredMessage).toBeDefined();
      expect(deliveredMessage?.Subject).toMatch(subjectPattern);

      // Assert subject is strictly PII-free
      expect(deliveredMessage?.Subject).not.toContain("principal.rao@vidyamandir.edu.in");
      expect(deliveredMessage?.Subject).not.toContain("Principal Rao");

      // Inspect message body details from Mailpit
      const detailRes = await fetch(`http://localhost:8025/api/v1/message/${deliveredMessage?.ID}`);
      expect(detailRes.ok).toBe(true);
      const messageDetail = (await detailRes.json()) as {
        Text?: string;
        HTML?: string;
        Snippet?: string;
      };
      const textContent = messageDetail.Text || messageDetail.Snippet || "";
      expect(textContent).toContain("Vidya Mandir Public School");
      expect(textContent).toContain("principal.rao@vidyamandir.edu.in");
      expect(textContent).toContain("Principal Rao");

      // 5. Assert notified_at is set in database
      const notifiedLead = await prismaService.lead.findUnique({
        where: { id: createdLeadId },
      });
      expect(notifiedLead).toBeDefined();
      expect(notifiedLead?.notifiedAt).toBeTruthy();
    });

    it("redacts spoofed client IP from request logs when submitting to public lead endpoint", async () => {
      const spoofedIp = "203.0.113.88";
      const startLogCount = testLogBuffer.length;

      const mockLead = {
        id: "a0000000-0000-0000-0000-000000000099",
        type: LeadType.CONTACT,
        name: "Principal Test",
        email: "principal.test@redaction.example",
        schoolName: "Redaction Test Academy",
        message: "Testing IP redaction in captured server logs",
        status: LeadStatus.NEW,
        consentText: "Consent text",
        consentedAt: new Date(),
        createdAt: new Date("2026-10-24T10:00:00.000Z"),
        updatedAt: new Date("2026-10-24T10:00:00.000Z"),
      };
      jest.spyOn(prismaService.lead, "create").mockResolvedValueOnce(mockLead as never);

      await request(app.getHttpServer())
        .post("/api/v1/public/contact")
        .set("Content-Type", "application/json")
        .set("X-Forwarded-For", spoofedIp)
        .set("X-Request-ID", "req-test-ip-redaction-e2e")
        .send({
          name: "Principal Test",
          email: "principal.test@redaction.example",
          schoolName: "Redaction Test Academy",
          message: "Testing IP redaction in captured server logs",
          consentGiven: true,
        })
        .expect(201);

      // Await next event-loop tick so Fastify's onResponse logging finishes
      await new Promise((resolve) => setTimeout(resolve, 50));

      const newLogs = testLogBuffer.slice(startLogCount).join("\n");
      // Raw spoofed IP must NOT appear in the captured logs
      expect(newLogs).not.toContain(spoofedIp);
      expect(newLogs).toContain("[Redacted]");
      expect(newLogs).toContain("req-test-ip-redaction-e2e");
    });
  });
});
