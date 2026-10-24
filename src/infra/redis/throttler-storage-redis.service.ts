import { Injectable, Logger } from "@nestjs/common";
import type { ThrottlerStorage } from "@nestjs/throttler";
import type { ThrottlerStorageRecord } from "@nestjs/throttler/dist/throttler-storage-record.interface";
import { RedisService } from "./redis.service";

@Injectable()
export class ThrottlerStorageRedisService implements ThrottlerStorage {
  private readonly logger = new Logger(ThrottlerStorageRedisService.name);

  // In-memory fallback for local dev/testing when Redis container is not running
  private readonly localMemoryStorage = new Map<
    string,
    { totalHits: number; expiresAt: number; blockExpiresAt?: number }
  >();

  constructor(private readonly redisService: RedisService) {}

  async increment(
    key: string,
    ttl: number, // in milliseconds
    limit: number,
    _blockDuration: number,
    _throttlerName: string,
  ): Promise<ThrottlerStorageRecord> {
    const redis = this.redisService.getClient();
    const redisKey = `throttle:${key}`;

    if (redis && redis.status === "ready") {
      try {
        const totalHits = await redis.incr(redisKey);
        if (totalHits === 1) {
          await redis.pexpire(redisKey, ttl);
        }

        let pttl = await redis.pttl(redisKey);
        if (pttl < 0) {
          await redis.pexpire(redisKey, ttl);
          pttl = ttl;
        }

        const timeToExpire = Math.ceil(pttl / 1000);
        const isBlocked = totalHits > limit;
        const timeToBlockExpire = isBlocked ? timeToExpire : 0;

        return {
          totalHits,
          timeToExpire,
          isBlocked,
          timeToBlockExpire,
        };
      } catch (err) {
        this.logger.warn({
          event: "redis_throttler_fallback",
          error: (err as Error).message,
        });
      }
    }

    // In-memory fallback
    const now = Date.now();
    const existing = this.localMemoryStorage.get(redisKey);

    if (!existing || existing.expiresAt <= now) {
      const record = {
        totalHits: 1,
        expiresAt: now + ttl,
      };
      this.localMemoryStorage.set(redisKey, record);
      return {
        totalHits: 1,
        timeToExpire: Math.ceil(ttl / 1000),
        isBlocked: 1 > limit,
        timeToBlockExpire: 0,
      };
    }

    existing.totalHits += 1;
    const timeToExpire = Math.max(0, Math.ceil((existing.expiresAt - now) / 1000));
    const isBlocked = existing.totalHits > limit;

    return {
      totalHits: existing.totalHits,
      timeToExpire,
      isBlocked,
      timeToBlockExpire: isBlocked ? timeToExpire : 0,
    };
  }

  public clearLocalCounters(): void {
    this.localMemoryStorage.clear();
  }
}
