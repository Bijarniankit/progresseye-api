import * as fs from "node:fs";
import * as path from "node:path";
import { NestFactory } from "@nestjs/core";
import { FastifyAdapter } from "@nestjs/platform-fastify";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";
import { AppModule } from "../app.module";

async function generateOpenApi() {
  const app = await NestFactory.create(AppModule, new FastifyAdapter(), {
    logger: false,
  });

  const apiPrefix = process.env.API_PREFIX || "/api/v1";
  app.setGlobalPrefix(apiPrefix);

  const config = new DocumentBuilder()
    .setTitle("ProgressEye API")
    .setDescription("ProgressEye 2.0 Multi-Tenant School Management API")
    .setVersion("1.0.0")
    .addBearerAuth()
    .build();

  const document = SwaggerModule.createDocument(app, config);

  const targetDirs = [
    path.resolve(__dirname, "../../openapi"),
    path.resolve(__dirname, "../../docs"),
  ];

  for (const dir of targetDirs) {
    fs.mkdirSync(dir, { recursive: true });
    const targetFile = path.join(dir, "openapi.json");
    fs.writeFileSync(targetFile, JSON.stringify(document, null, 2), "utf-8");
    console.log(`[OpenAPI Export] Spec written to ${targetFile}`);
  }

  await app.close();
  process.exit(0);
}

generateOpenApi().catch((err) => {
  console.error("Failed to generate OpenAPI spec:", err);
  process.exit(1);
});
