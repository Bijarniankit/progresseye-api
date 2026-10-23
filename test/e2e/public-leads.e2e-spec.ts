import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { Test, type TestingModule } from "@nestjs/testing";
import { LeadStatus, LeadType } from "@prisma/client";

import request = require("supertest");

import { AppModule } from "../../src/app.module";
import { PrismaService } from "../../src/infra/prisma/prisma.service";

describe("Public Leads API E2E Tests", () => {
  let app: NestFastifyApplication;
  let prismaService: PrismaService;

  beforeAll(async () => {
    process.env.DATABASE_URL = "postgresql://postgres:postgres@localhost:5432/test_db";
    process.env.THROTTLE_LIMIT = "100";
    process.env.THROTTLE_TTL = "60000";

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    app.setGlobalPrefix("/api/v1");

    prismaService = moduleFixture.get<PrismaService>(PrismaService);

    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    if (app) {
      await app.close();
    }
  });

  describe("POST /api/v1/public/contact", () => {
    it("returns HTTP 201 with receipt on valid contact inquiry", async () => {
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

      const paramNames = response.body.invalidParams.map((p: { name: string }) => p.name);
      expect(paramNames).toContain("name");
      expect(paramNames).toContain("email");
      expect(paramNames).toContain("message");
      expect(paramNames).toContain("consentGiven");
    });

    it("returns HTTP 400 when bot honeypot field is populated", async () => {
      const response = await request(app.getHttpServer())
        .post("/api/v1/public/contact")
        .send({
          name: "Bot Spammer",
          email: "bot@spammer.org",
          schoolName: "Spam School",
          message: "Buy cheap backlinks now!",
          consentGiven: true,
          website_url: "https://spam.example.com",
        })
        .expect(400);

      expect(response.headers["content-type"]).toContain("application/problem+json");
      expect(response.body.detail).toContain("Invalid submission");
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
        message: "Looking for attendance module | Preferred time: Morning",
        status: LeadStatus.NEW,
        consentText: "Consent text",
        consentedAt: new Date(),
        createdAt: new Date("2026-10-24T11:00:00.000Z"),
        updatedAt: new Date("2026-10-24T11:00:00.000Z"),
      };

      jest.spyOn(prismaService.lead, "create").mockResolvedValueOnce(mockLead as never);

      const response = await request(app.getHttpServer())
        .post("/api/v1/public/demo")
        .send({
          name: "Dean K. Patel",
          email: "patel@vidyamandir.edu.in",
          schoolName: "Vidya Mandir School",
          notes: "Looking for attendance module",
          preferredTime: "Morning",
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
});
