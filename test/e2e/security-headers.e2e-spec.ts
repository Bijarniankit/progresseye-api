import helmet from "@fastify/helmet";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { Test, type TestingModule } from "@nestjs/testing";
import request from "supertest";

import { AppModule } from "../../src/app.module";
import { getHelmetConfig } from "../../src/config/helmet.config";
import { PrismaService } from "../../src/infra/prisma/prisma.service";
import { RedisService } from "../../src/infra/redis/redis.service";

describe("Security Headers E2E Tests", () => {
  let app: NestFastifyApplication;

  beforeAll(async () => {
    process.env.DATABASE_URL = "postgresql://postgres:postgres@localhost:5432/test_db";
    process.env.THROTTLE_LIMIT = "10";
    process.env.THROTTLE_TTL = "60000";

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    app.setGlobalPrefix("/api/v1");

    const prismaService = moduleFixture.get<PrismaService>(PrismaService);
    const redisService = moduleFixture.get<RedisService>(RedisService);

    jest.spyOn(prismaService, "ping").mockResolvedValue(true);
    jest.spyOn(redisService, "ping").mockResolvedValue(true);

    // Register helmet with staging configuration
    await app.register(
      helmet as unknown as Parameters<typeof app.register>[0],
      getHelmetConfig("staging"),
    );

    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    if (app) {
      await app.close();
    }
  });

  it("enforces Content-Security-Policy-Report-Only without a public report endpoint and without CDN leak", async () => {
    const res = await request(app.getHttpServer()).get("/api/v1/health/live");

    expect(res.headers["content-security-policy-report-only"]).toBeDefined();
    const csp = res.headers["content-security-policy-report-only"];
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).not.toContain("cdn.jsdelivr.net");
    expect(csp).not.toContain("fonts.googleapis.com");
    expect(csp).not.toContain("report-uri");
  });

  it("enforces short max-age HSTS without preload and without includeSubDomains on staging", async () => {
    const res = await request(app.getHttpServer()).get("/api/v1/health/live");

    expect(res.headers["strict-transport-security"]).toBeDefined();
    const hsts = res.headers["strict-transport-security"];
    expect(hsts).toContain("max-age=86400");
    expect(hsts).not.toContain("includeSubDomains");
    expect(hsts).not.toContain("preload");
  });

  it("produces separate 5-minute initial ramp HSTS production config without preload or includeSubDomains", () => {
    const prodConfig = getHelmetConfig("production");
    expect(prodConfig.hsts).toEqual({
      maxAge: 300,
      includeSubDomains: false,
      preload: false,
    });
  });

  it("honors HSTS_MAX_AGE_SECONDS environment override when provided", () => {
    process.env.HSTS_MAX_AGE_SECONDS = "604800";
    try {
      const config = getHelmetConfig("production");
      expect(config.hsts).toEqual({
        maxAge: 604800,
        includeSubDomains: false,
        preload: false,
      });
    } finally {
      delete process.env.HSTS_MAX_AGE_SECONDS;
    }
  });

  it("enforces standard anti-framing and MIME sniffing protection", async () => {
    const res = await request(app.getHttpServer()).get("/api/v1/health/live");

    expect(res.headers["x-frame-options"]).toBe("DENY");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
  });
});
