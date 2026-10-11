import { NestFactory } from "@nestjs/core";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";
import { AppModule } from "./app.module";

async function bootstrap() {
  const app = await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter());

  const apiPrefix = process.env.API_PREFIX || "/api/v1";
  app.setGlobalPrefix(apiPrefix);

  app.enableCors({
    origin: process.env.CORS_ORIGIN || "http://localhost:3000",
    credentials: true,
  });

  const config = new DocumentBuilder()
    .setTitle("ProgressEye API")
    .setDescription("ProgressEye 2.0 Multi-Tenant School Management API")
    .setVersion("1.0.0")
    .addBearerAuth()
    .build();

  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup(`${apiPrefix}/docs`, app, document, {
    jsonDocumentUrl: `${apiPrefix}/openapi.json`,
  });

  const port = process.env.PORT || 4000;
  await app.listen(port, "0.0.0.0");
  console.log(`ProgressEye API running on http://localhost:${port}${apiPrefix}`);
  console.log(`OpenAPI spec available at http://localhost:${port}${apiPrefix}/openapi.json`);
}

bootstrap();
