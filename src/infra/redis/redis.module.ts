import { Global, Module } from "@nestjs/common";
import { ConfigModule } from "../../config/config.module";
import { RedisService } from "./redis.service";
import { ThrottlerStorageRedisService } from "./throttler-storage-redis.service";

@Global()
@Module({
  imports: [ConfigModule],
  providers: [RedisService, ThrottlerStorageRedisService],
  exports: [RedisService, ThrottlerStorageRedisService],
})
export class RedisModule {}
