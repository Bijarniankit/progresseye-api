import helmet from "@fastify/helmet";
import { NestFactory } from "@nestjs/core";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";
import { apiReference } from "@scalar/nestjs-api-reference";
import { Logger } from "nestjs-pino";
import { AppModule } from "./app.module";
import { AppConfigService } from "./config/config.service";
import { validateEnv } from "./config/env.schema";
import { getHelmetConfig } from "./config/helmet.config";

async function bootstrap() {
  const env = validateEnv(process.env);

  let trustProxy: boolean | string | string[] | ((address: string, hop: number) => boolean) = false;
  if (env.TRUSTED_PROXIES && env.TRUSTED_PROXIES.trim().length > 0) {
    const proxies = env.TRUSTED_PROXIES.split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    if (proxies.length === 1 && proxies[0]) {
      trustProxy = proxies[0];
    } else if (proxies.length > 1) {
      trustProxy = proxies;
    }
  } else if (env.TRUSTED_PROXY_COUNT > 0) {
    const proxyCount = env.TRUSTED_PROXY_COUNT;
    trustProxy = (_address: string, hop: number) => hop < proxyCount;
  }

  const adapter = new FastifyAdapter({
    bodyLimit: 1048576, // 1MB body limit
    trustProxy,
  });

  const app = await NestFactory.create<NestFastifyApplication>(AppModule, adapter, {
    bufferLogs: true,
  });

  const config = app.get(AppConfigService);
  const logger = app.get(Logger);
  app.useLogger(logger);

  // Enable graceful shutdown
  app.enableShutdownHooks();

  const apiPrefix = config.get("API_PREFIX");
  app.setGlobalPrefix(apiPrefix);

  // Security: Helmet
  await app.register(
    helmet as unknown as Parameters<typeof app.register>[0],
    getHelmetConfig(config.get("APP_ENV")),
  );

  // Security: Strict CORS
  app.enableCors({
    origin: config.get("CORS_ORIGIN"),
    credentials: true,
    methods: ["GET", "HEAD", "PUT", "PATCH", "POST", "DELETE", "OPTIONS"],
    allowedHeaders: [
      "Content-Type",
      "Authorization",
      "x-request-id",
      "x-school-id",
      "Idempotency-Key",
      "idempotency-key",
    ],
  });

  // OpenAPI & Scalar docs setup (disabled in production)
  const isProduction = config.get("APP_ENV") === "production";
  if (!isProduction) {
    const swaggerConfig = new DocumentBuilder()
      .setTitle("ProgressEye API")
      .setDescription("ProgressEye 2.0 Multi-Tenant School Management API")
      .setVersion("1.0.0")
      .addBearerAuth()
      .build();

    const document = SwaggerModule.createDocument(app, swaggerConfig);

    // Raw JSON spec endpoint
    const fastify = app.getHttpAdapter().getInstance();
    fastify.get(`${apiPrefix}/openapi.json`, (_req, reply) => {
      reply.header("Content-Type", "application/json").send(document);
    });

    // Scalar docs UI at /docs with scoped CDN allowances for Swagger/Scalar
    const scalarHandler = apiReference({
      spec: {
        content: document,
      },
      withFastify: true,
    });
    fastify.get("/docs", (req, reply) => {
      reply.header(
        "Content-Security-Policy-Report-Only",
        "default-src 'self'; script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: https:; frame-ancestors 'none'",
      );
      (scalarHandler as unknown as (req: unknown, res: unknown) => void)(req.raw, reply.raw);
    });
  }

  const port = config.get("PORT");
  await app.listen(port, "0.0.0.0");
  logger.log(`ProgressEye API running on http://localhost:${port}${apiPrefix}`);
  logger.log(`Scalar API docs available at http://localhost:${port}/docs`);
  logger.log(
    `OpenAPI specification available at http://localhost:${port}${apiPrefix}/openapi.json`,
  );
}

bootstrap();
