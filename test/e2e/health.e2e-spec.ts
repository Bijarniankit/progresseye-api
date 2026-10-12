import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { Test, type TestingModule } from "@nestjs/testing";
import request = require("supertest");
import { AppModule } from "../../src/app.module";
import { PrismaService } from "../../src/infra/prisma/prisma.service";
import { RedisService } from "../../src/infra/redis/redis.service";

describe("Health & Security E2E Tests", () => {
  let app: NestFastifyApplication;
  let prismaService: PrismaService;
  let redisService: RedisService;

  beforeAll(async () => {
    process.env.DATABASE_URL = "postgresql://postgres:postgres@localhost:5432/test_db";
    process.env.THROTTLE_LIMIT = "10";
    process.env.THROTTLE_TTL = "60000";

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    app.setGlobalPrefix("/api/v1");

    prismaService = moduleFixture.get<PrismaService>(PrismaService);
    redisService = moduleFixture.get<RedisService>(RedisService);

    // Mock ping defaults to healthy
    jest.spyOn(prismaService, "ping").mockResolvedValue(true);
    jest.spyOn(redisService, "ping").mockResolvedValue(true);

    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    if (app) {
      await app.close();
    }
  });

  describe("GET /api/v1/health/live", () => {
    it("should return HTTP 200 with status ok", async () => {
      const response = await request(app.getHttpServer()).get("/api/v1/health/live").expect(200);

      expect(response.body).toHaveProperty("status", "ok");
      expect(response.body).toHaveProperty("timestamp");
    });
  });

  describe("GET /api/v1/health/ready", () => {
    it("should return HTTP 200 when database and redis are healthy", async () => {
      jest.spyOn(prismaService, "ping").mockResolvedValueOnce(true);
      jest.spyOn(redisService, "ping").mockResolvedValueOnce(true);

      const response = await request(app.getHttpServer()).get("/api/v1/health/ready").expect(200);

      expect(response.body).toHaveProperty("status", "ok");
      expect(response.body.details.database.status).toBe("up");
      expect(response.body.details.redis.status).toBe("up");
    });

    it("should return HTTP 503 problem+json when database is down", async () => {
      jest.spyOn(prismaService, "ping").mockResolvedValueOnce(false);

      const response = await request(app.getHttpServer()).get("/api/v1/health/ready").expect(503);

      expect(response.headers["content-type"]).toContain("application/problem+json");
      expect(response.body).toHaveProperty("code", "SERVICE_UNAVAILABLE");
      expect(response.body).toHaveProperty("status", 503);
    });
  });

  describe("Error Handling & RFC 9457", () => {
    it("should return 404 with application/problem+json on unknown routes", async () => {
      const response = await request(app.getHttpServer())
        .get("/api/v1/non-existent-route-404")
        .expect(404);

      expect(response.headers["content-type"]).toContain("application/problem+json");
      expect(response.body).toHaveProperty("code", "NOT_FOUND");
      expect(response.body).toHaveProperty("status", 404);
      expect(response.body).toHaveProperty("title", "Resource Not Found");
    });
  });

  describe("Throttling / Rate Limiting", () => {
    it("should return 429 problem+json when request limit is exceeded", async () => {
      // Fire requests exceeding throttle limit (limit is 10)
      const requests = Array.from({ length: 15 }, () =>
        request(app.getHttpServer()).get("/api/v1/health/live"),
      );

      const responses = await Promise.all(requests);
      const throttled = responses.find((r) => r.status === 429);

      expect(throttled).toBeDefined();
      if (throttled) {
        expect(throttled.headers["content-type"]).toContain("application/problem+json");
        expect(throttled.body).toHaveProperty("code", "RATE_LIMIT_EXCEEDED");
        expect(throttled.body).toHaveProperty("status", 429);
      }
    });
  });
});
