import helmet from "@fastify/helmet";
import { NestFactory } from "@nestjs/core";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";
import { apiReference } from "@scalar/nestjs-api-reference";
import { Logger } from "nestjs-pino";
import { AppModule } from "./app.module";
import { AppConfigService } from "./config/config.service";

async function bootstrap() {
  const adapter = new FastifyAdapter({
    bodyLimit: 1048576, // 1MB body limit
    trustProxy: true,
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
  await app.register(helmet as unknown as Parameters<typeof app.register>[0], {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        styleSrc: [
          "'self'",
          "'unsafe-inline'",
          "https://cdn.jsdelivr.net",
          "https://fonts.googleapis.com",
        ],
        fontSrc: ["'self'", "https://fonts.gstatic.com"],
        imgSrc: ["'self'", "data:", "https:"],
        scriptSrc: ["'self'", "'unsafe-inline'", "https://cdn.jsdelivr.net"],
      },
    },
  });

  // Security: Strict CORS
  app.enableCors({
    origin: config.get("CORS_ORIGIN"),
    credentials: true,
    methods: ["GET", "HEAD", "PUT", "PATCH", "POST", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "x-request-id", "x-school-id"],
  });

  // OpenAPI setup
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

  // Scalar docs UI at /docs
  const scalarHandler = apiReference({
    spec: {
      content: document,
    },
    withFastify: true,
  });
  fastify.get("/docs", (req, reply) => {
    (scalarHandler as unknown as (req: unknown, res: unknown) => void)(req.raw, reply.raw);
  });

  const port = config.get("PORT");
  await app.listen(port, "0.0.0.0");
  logger.log(`ProgressEye API running on http://localhost:${port}${apiPrefix}`);
  logger.log(`Scalar API docs available at http://localhost:${port}/docs`);
  logger.log(
    `OpenAPI specification available at http://localhost:${port}${apiPrefix}/openapi.json`,
  );
}

bootstrap();
