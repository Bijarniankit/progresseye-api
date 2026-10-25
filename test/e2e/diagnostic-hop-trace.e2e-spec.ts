import { FastifyAdapter, NestFastifyApplication } from "@nestjs/platform-fastify";
import { Test, TestingModule } from "@nestjs/testing";
import request from "supertest";
import { AppModule } from "../../src/app.module";
import { AppConfigService } from "../../src/config/config.service";

describe("Diagnostic Hop Trace E2E", () => {
  let app: NestFastifyApplication;
  let config: AppConfigService;

  beforeAll(async () => {
    process.env.DIAGNOSTICS_ENABLED = "true";
    process.env.APP_ENV = "staging";

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    app.setGlobalPrefix("api/v1");

    config = moduleFixture.get<AppConfigService>(AppConfigService);

    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it("returns clientReportedHops, hash prefixes, and NEVER leaks raw client IP", async () => {
    const spoofedClientIp = "203.0.113.195";
    const proxyIp = "198.51.100.17";

    const res = await request(app.getHttpServer())
      .get("/api/v1/diagnostic/hop-trace")
      .set("X-Forwarded-For", `${spoofedClientIp}, ${proxyIp}`);

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
    expect(res.body.diagnosticNote).toContain("X-Forwarded-For");
    expect(res.body.clientReportedHops).toBe(2);
    expect(res.body.fastifyTrustedProxyCount).toBeDefined();

    expect(res.body.socketIpHashPrefix).toMatch(/^[0-9a-f]{8}$/);
    expect(res.body.derivedIpHashPrefix).toMatch(/^[0-9a-f]{8}$/);
    expect(typeof res.body.matchesSocketIp).toBe("boolean");

    // Assert that raw IP never appears anywhere in the serialized response
    const rawResponseText = JSON.stringify(res.body);
    expect(rawResponseText).not.toContain(spoofedClientIp);
    expect(rawResponseText).not.toContain(proxyIp);
    expect(rawResponseText).not.toContain("127.0.0.1");
  });

  it("accurately reports 0 hops when X-Forwarded-For is absent", async () => {
    const res = await request(app.getHttpServer()).get("/api/v1/diagnostic/hop-trace");

    expect(res.status).toBe(200);
    expect(res.body.clientReportedHops).toBe(0);
    expect(res.body.socketIpHashPrefix).toMatch(/^[0-9a-f]{8}$/);
  });

  it("returns 404 when in production environment", async () => {
    const originalIsProduction = config.isProduction;

    Object.defineProperty(config, "isProduction", {
      value: true,
      configurable: true,
    });

    try {
      const res = await request(app.getHttpServer()).get("/api/v1/diagnostic/hop-trace");
      expect(res.status).toBe(404);
      expect(JSON.stringify(res.body)).toContain("disabled");
    } finally {
      Object.defineProperty(config, "isProduction", {
        value: originalIsProduction,
        configurable: true,
      });
    }
  });

  it("returns 404 when DIAGNOSTICS_ENABLED is false", async () => {
    const originalGet = config.get.bind(config);
    jest.spyOn(config, "get").mockImplementation((key: string) => {
      if (key === "DIAGNOSTICS_ENABLED") return false;
      return originalGet(key as never);
    });

    try {
      const res = await request(app.getHttpServer()).get("/api/v1/diagnostic/hop-trace");
      expect(res.status).toBe(404);
    } finally {
      jest.restoreAllMocks();
    }
  });
});
