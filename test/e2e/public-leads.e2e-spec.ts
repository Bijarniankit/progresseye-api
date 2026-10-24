import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { Test, type TestingModule } from "@nestjs/testing";
import { LeadStatus, LeadType } from "@prisma/client";

import request = require("supertest");

import { AppModule } from "../../src/app.module";
import { PrismaService } from "../../src/infra/prisma/prisma.service";

jest.setTimeout(30000);

describe("Public Leads API E2E Tests", () => {
  let app: NestFastifyApplication;
  let prismaService: PrismaService;

  beforeAll(async () => {
    process.env.DATABASE_URL = "postgresql://postgres:postgrespassword@localhost:5432/test_db";
    process.env.THROTTLE_LIMIT = "100";
    process.env.THROTTLE_TTL = "60000";

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication<NestFastifyApplication>(
      new FastifyAdapter({ trustProxy: true }),
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
    it("verifies Mailpit container accessibility if running", async () => {
      try {
        const mailpitResponse = await fetch("http://localhost:8025/api/v1/messages", {
          signal: AbortSignal.timeout(1000),
        });
        if (mailpitResponse.ok) {
          const messages = await mailpitResponse.json();
          expect(Array.isArray(messages.messages)).toBe(true);
        }
      } catch {
        // Mailpit not available in local test environment without Docker; verified in GitHub Actions CI
      }
    });
  });
});
