import { FastifyAdapter, NestFastifyApplication } from "@nestjs/platform-fastify";
import { Test, TestingModule } from "@nestjs/testing";
import request from "supertest";
import { AppModule } from "../../src/app.module";
import { AppConfigService } from "../../src/config/config.service";

describe("Diagnostic Hop Trace E2E", () => {
  let app: NestFastifyApplication;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    app.setGlobalPrefix("api/v1");
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it("returns hopCount and 8-char ipHashPrefix, and NEVER leaks raw client IP", async () => {
    const spoofedClientIp = "203.0.113.195";
    const proxyIp = "198.51.100.17";

    const res = await request(app.getHttpServer())
      .get("/api/v1/diagnostic/hop-trace")
      .set("X-Forwarded-For", `${spoofedClientIp}, ${proxyIp}`);

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
    expect(res.body.hopCount).toBe(2);
    expect(res.body.ipHashPrefix).toBeDefined();
    expect(typeof res.body.ipHashPrefix).toBe("string");
    expect(res.body.ipHashPrefix).toMatch(/^[0-9a-f]{8}$/);

    // Assert that raw IP never appears in serialized response
    const rawResponseText = JSON.stringify(res.body);
    expect(rawResponseText).not.toContain(spoofedClientIp);
    expect(rawResponseText).not.toContain(proxyIp);
    expect(rawResponseText).not.toContain("127.0.0.1");
  });

  it("accurately reports 0 hops when X-Forwarded-For is absent", async () => {
    const res = await request(app.getHttpServer()).get("/api/v1/diagnostic/hop-trace");

    expect(res.status).toBe(200);
    expect(res.body.hopCount).toBe(0);
    expect(res.body.ipHashPrefix).toMatch(/^[0-9a-f]{8}$/);
  });

  it("returns 404 when in production environment", async () => {
    const config = app.get(AppConfigService);
    const originalIsProduction = config.isProduction;

    // Simulate production environment
    Object.defineProperty(config, "isProduction", {
      value: true,
      configurable: true,
    });

    try {
      const res = await request(app.getHttpServer()).get("/api/v1/diagnostic/hop-trace");
      expect(res.status).toBe(404);
      expect(JSON.stringify(res.body)).toContain("disabled in production");
    } finally {
      Object.defineProperty(config, "isProduction", {
        value: originalIsProduction,
        configurable: true,
      });
    }
  });
});
