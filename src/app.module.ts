import { Module } from "@nestjs/common";
import { APP_FILTER, APP_GUARD } from "@nestjs/core";
import { ThrottlerGuard, ThrottlerModule } from "@nestjs/throttler";
import { LoggerModule } from "nestjs-pino";
import { ProblemExceptionFilter } from "./common/filters/problem-exception.filter";
import { ConfigModule } from "./config/config.module";
import { AppConfigService } from "./config/config.service";
import { PrismaModule } from "./infra/prisma/prisma.module";
import { RedisModule } from "./infra/redis/redis.module";
import { ThrottlerStorageRedisService } from "./infra/redis/throttler-storage-redis.service";
import { HealthModule } from "./modules/platform/health/health.module";
import { PublicModule } from "./modules/public/public.module";

@Module({
  imports: [
    ConfigModule,
    LoggerModule.forRootAsync({
      imports: [ConfigModule],
      inject: [AppConfigService],
      useFactory: (config: AppConfigService) => ({
        pinoHttp: {
          level: config.get("LOG_LEVEL"),
          transport: config.isDevelopment
            ? {
                target: "pino-pretty",
                options: {
                  colorize: true,
                  singleLine: true,
                  translateTime: "SYS:standard",
                },
              }
            : undefined,
          autoLogging: {
            ignore: (req) => (req.url ? req.url.includes("/health/live") : false),
          },
          genReqId: (req) =>
            (req.headers["x-request-id"] as string | undefined) ?? crypto.randomUUID(),
          redact: [
            "req.headers.authorization",
            "req.headers.cookie",
            "body.password",
            "body.token",
            "body.secret",
            "body.apiKey",
            "body.email",
            "body.name",
            "body.schoolName",
            "body.message",
            "body.notes",
            "body.turnstileToken",
            "body.website_url",
            "body.topic",
          ],
        },
      }),
    }),
    ThrottlerModule.forRootAsync({
      imports: [ConfigModule, RedisModule],
      inject: [AppConfigService, ThrottlerStorageRedisService],
      useFactory: (config: AppConfigService, storage: ThrottlerStorageRedisService) => ({
        throttlers: [
          {
            name: "default",
            ttl: config.get("THROTTLE_TTL"),
            limit: config.get("THROTTLE_LIMIT"),
          },
        ],
        storage,
      }),
    }),
    PrismaModule,
    RedisModule,
    HealthModule,
    PublicModule,
  ],
  controllers: [],
  providers: [
    {
      provide: APP_FILTER,
      useClass: ProblemExceptionFilter,
    },
    {
      provide: APP_GUARD,
      useClass: ThrottlerGuard,
    },
  ],
})
export class AppModule {}
