import { Injectable, Logger } from "@nestjs/common";
import { RedisService } from "../../../infra/redis/redis.service";

@Injectable()
export class PermissionCacheService {
  private readonly logger = new Logger(PermissionCacheService.name);
  private readonly TTL_SECONDS = 15 * 60; // 15 minutes
  private readonly TIMEOUT_MS = 250; // 250ms operation timeout

  constructor(private readonly redisService: RedisService) {}

  /**
   * Retrieves cached effective permissions for a user within a school tenant.
   * Employs a short 250ms timeout with timer cleanup and falls back to null on failure/timeout.
   */
  async get(schoolId: string, userId: string): Promise<string[] | null> {
    const client = this.redisService.getClient();
    if (!client || client.status !== "ready") {
      return null;
    }

    const key = `auth:perm:${schoolId}:${userId}`;
    let timer: NodeJS.Timeout | undefined;
    try {
      const getPromise = client.get(key);
      const timeoutPromise = new Promise<null>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Redis get timeout")), this.TIMEOUT_MS);
      });

      const raw = await Promise.race([getPromise, timeoutPromise]);
      if (!raw) return null;
      return JSON.parse(raw as string) as string[];
    } catch (err) {
      this.logger.warn(`Permission cache read failure for ${key}: ${(err as Error).message}`);
      return null;
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
    }
  }

  /**
   * Caches effective permissions with a 15-minute TTL and timer cleanup.
   */
  async set(schoolId: string, userId: string, permissions: string[]): Promise<void> {
    const client = this.redisService.getClient();
    if (!client || client.status !== "ready") {
      return;
    }

    const key = `auth:perm:${schoolId}:${userId}`;
    let timer: NodeJS.Timeout | undefined;
    try {
      const setPromise = client.setex(key, this.TTL_SECONDS, JSON.stringify(permissions));
      const timeoutPromise = new Promise<void>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Redis set timeout")), this.TIMEOUT_MS);
      });

      await Promise.race([setPromise, timeoutPromise]);
    } catch (err) {
      this.logger.warn(`Permission cache write failure for ${key}: ${(err as Error).message}`);
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
    }
  }

  /**
   * Evicts cached permissions for a single user.
   * Logs at ERROR level and throws on failure to fail the calling mutation.
   */
  async evictUser(schoolId: string, userId: string): Promise<void> {
    const client = this.redisService.getClient();
    if (!client || client.status !== "ready") {
      const err = new Error("Redis client not available for cache eviction");
      this.logger.error(
        `Permission cache evict failure for auth:perm:${schoolId}:${userId}: ${err.message}`,
      );
      throw err;
    }

    const key = `auth:perm:${schoolId}:${userId}`;
    try {
      await client.del(key);
    } catch (err) {
      this.logger.error(`Permission cache evict failure for ${key}: ${(err as Error).message}`);
      throw err;
    }
  }

  /**
   * Evicts cached permissions for multiple users holding a modified role.
   * Logs at ERROR level and throws on failure to fail the calling mutation.
   */
  async evictUsers(schoolId: string, userIds: string[]): Promise<void> {
    if (!userIds.length) return;
    const client = this.redisService.getClient();
    if (!client || client.status !== "ready") {
      const err = new Error("Redis client not available for multi-cache eviction");
      this.logger.error(`Permission cache multi-evict failure: ${err.message}`);
      throw err;
    }

    const keys = userIds.map((uid) => `auth:perm:${schoolId}:${uid}`);
    try {
      await client.del(...keys);
    } catch (err) {
      this.logger.error(`Permission cache multi-evict failure: ${(err as Error).message}`);
      throw err;
    }
  }
}
