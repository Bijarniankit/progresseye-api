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
   * Employs a short 250ms timeout and falls back to null on failure/timeout.
   */
  async get(schoolId: string, userId: string): Promise<string[] | null> {
    const client = this.redisService.getClient();
    if (!client || client.status !== "ready") {
      return null;
    }

    const key = `auth:perm:${schoolId}:${userId}`;
    try {
      const getPromise = client.get(key);
      const timeoutPromise = new Promise<null>((_, reject) =>
        setTimeout(() => reject(new Error("Redis get timeout")), this.TIMEOUT_MS),
      );

      const raw = await Promise.race([getPromise, timeoutPromise]);
      if (!raw) return null;
      return JSON.parse(raw as string) as string[];
    } catch (err) {
      this.logger.warn(`Permission cache read failure for ${key}: ${(err as Error).message}`);
      return null;
    }
  }

  /**
   * Caches effective permissions with a 15-minute TTL.
   */
  async set(schoolId: string, userId: string, permissions: string[]): Promise<void> {
    const client = this.redisService.getClient();
    if (!client || client.status !== "ready") {
      return;
    }

    const key = `auth:perm:${schoolId}:${userId}`;
    try {
      const setPromise = client.setex(key, this.TTL_SECONDS, JSON.stringify(permissions));
      const timeoutPromise = new Promise<void>((_, reject) =>
        setTimeout(() => reject(new Error("Redis set timeout")), this.TIMEOUT_MS),
      );

      await Promise.race([setPromise, timeoutPromise]);
    } catch (err) {
      this.logger.warn(`Permission cache write failure for ${key}: ${(err as Error).message}`);
    }
  }

  /**
   * Evicts cached permissions for a single user.
   */
  async evictUser(schoolId: string, userId: string): Promise<void> {
    const client = this.redisService.getClient();
    if (!client || client.status !== "ready") {
      return;
    }

    const key = `auth:perm:${schoolId}:${userId}`;
    try {
      await client.del(key);
    } catch (err) {
      this.logger.warn(`Permission cache evict failure for ${key}: ${(err as Error).message}`);
    }
  }

  /**
   * Evicts cached permissions for multiple users holding a modified role.
   */
  async evictUsers(schoolId: string, userIds: string[]): Promise<void> {
    if (!userIds.length) return;
    const client = this.redisService.getClient();
    if (!client || client.status !== "ready") {
      return;
    }

    const keys = userIds.map((uid) => `auth:perm:${schoolId}:${uid}`);
    try {
      await client.del(...keys);
    } catch (err) {
      this.logger.warn(`Permission cache multi-evict failure: ${(err as Error).message}`);
    }
  }
}
