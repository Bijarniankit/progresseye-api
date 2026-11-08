import {
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  UnauthorizedException,
} from "@nestjs/common";
import { hmacHash } from "../../../common/utils/sanitization";
import { AppConfigService } from "../../../config/config.service";
import { RedisService } from "../../../infra/redis/redis.service";

@Injectable()
export class AbusePreventionService {
  private readonly logger = new Logger(AbusePreventionService.name);
  private readonly hmacSecret: string;
  // Local in-memory fallbacks when Redis is offline (e.g. unit testing or standalone mode)
  private readonly memoryCache = new Map<string, { count: number; expiresAt: number }>();

  constructor(
    private readonly redisService: RedisService,
    private readonly config: AppConfigService,
  ) {
    this.hmacSecret = this.config.get("AUTH_LOG_HMAC_SECRET");
  }

  private getHmac(value: string): string {
    return hmacHash(value, this.hmacSecret);
  }

  /**
   * Checks both per-IP rate limit and account+IP pair lockout before login execution.
   * Prevents trivial Denial of Service: failed attempts from IP A lock out only IP A,
   * while legitimate user on IP B remains able to log in.
   */
  async checkPreLogin(ip: string, email: string, schoolId: string): Promise<void> {
    const ipHmac = this.getHmac(ip);
    const emailHmac = this.getHmac(email);

    // 1. Per-IP Rate Limit (Max 20 attempts per 15 min across any accounts)
    const ipAttempts = await this.getCounter(`ratelimit:auth:ip:${ipHmac}`);
    if (ipAttempts >= 20) {
      this.logger.warn({
        event: "platform_audit",
        action: "AUTH.IP_BLOCKED",
        ipHmac,
        reason: "Per-IP rate limit exceeded",
      });
      throw new HttpException(
        {
          statusCode: HttpStatus.TOO_MANY_REQUESTS,
          error: "Too Many Requests",
          message:
            "Too many authentication attempts from this network. Please try again in 15 minutes.",
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    // 2. Account + IP Pair Lockout (Max 5 failed attempts per IP for this specific account)
    const pairKey = `ratelimit:auth:pair:${schoolId}:${emailHmac}:${ipHmac}`;
    const pairAttempts = await this.getCounter(pairKey);
    if (pairAttempts >= 5) {
      this.logger.warn({
        event: "tenant_audit",
        action: "AUTH.ACCOUNT_IP_LOCKED",
        schoolId,
        emailHmac,
        ipHmac,
        reason: "Max account attempts from this IP reached",
      });
      // Generic error response to prevent user existence enumeration
      throw new UnauthorizedException("Invalid credentials.");
    }
  }

  /**
   * Records a failed login attempt for both the client IP and the (account, IP) pair.
   */
  async recordFailedLogin(ip: string, email: string, schoolId: string): Promise<number> {
    const ipHmac = this.getHmac(ip);
    const emailHmac = this.getHmac(email);

    await this.incrementCounter(`ratelimit:auth:ip:${ipHmac}`, 900); // 15 min
    const pairKey = `ratelimit:auth:pair:${schoolId}:${emailHmac}:${ipHmac}`;
    const pairAttempts = await this.incrementCounter(pairKey, 900); // 15 min

    return pairAttempts;
  }

  /**
   * Resets the account+IP lockout counter upon successful authentication.
   */
  async recordSuccessfulLogin(ip: string, email: string, schoolId: string): Promise<void> {
    const ipHmac = this.getHmac(ip);
    const emailHmac = this.getHmac(email);
    const pairKey = `ratelimit:auth:pair:${schoolId}:${emailHmac}:${ipHmac}`;
    await this.deleteKey(pairKey);
  }

  /**
   * Stores a successor token pair during refresh for the 10-second grace window.
   */
  async cacheSuccessorToken(
    tokenHash: string,
    data: Record<string, unknown>,
    ttlSeconds = 10,
  ): Promise<void> {
    const key = `auth:grace:${tokenHash}`;
    const client = this.redisService.getClient();
    if (client && client.status === "ready") {
      try {
        await client.setex(key, ttlSeconds, JSON.stringify(data));
        return;
      } catch {
        // Fall back to memory cache
      }
    }
    this.memoryCache.set(key, {
      count: 1,
      expiresAt: Date.now() + ttlSeconds * 1000,
      ...data,
    });
  }

  /**
   * Retrieves the cached successor token pair if within the 10-second grace window.
   */
  async getSuccessorToken(tokenHash: string): Promise<Record<string, unknown> | null> {
    const key = `auth:grace:${tokenHash}`;
    const client = this.redisService.getClient();
    if (client && client.status === "ready") {
      try {
        const val = await client.get(key);
        return val ? JSON.parse(val) : null;
      } catch {
        // Fall back to memory cache
      }
    }
    const mem = this.memoryCache.get(key);
    if (!mem) return null;
    if (Date.now() > mem.expiresAt) {
      this.memoryCache.delete(key);
      return null;
    }
    return mem as unknown as Record<string, unknown>;
  }

  // --- Redis & Memory Helper Methods ---

  private async getCounter(key: string): Promise<number> {
    const client = this.redisService.getClient();
    if (client && client.status === "ready") {
      try {
        const val = await client.get(key);
        return val ? Number.parseInt(val, 10) : 0;
      } catch {
        // fallback
      }
    }
    const mem = this.memoryCache.get(key);
    if (!mem) return 0;
    if (Date.now() > mem.expiresAt) {
      this.memoryCache.delete(key);
      return 0;
    }
    return mem.count;
  }

  private async incrementCounter(key: string, ttlSeconds: number): Promise<number> {
    const client = this.redisService.getClient();
    if (client && client.status === "ready") {
      try {
        const count = await client.incr(key);
        if (count === 1) {
          await client.expire(key, ttlSeconds);
        }
        return count;
      } catch {
        // fallback
      }
    }
    const now = Date.now();
    const existing = this.memoryCache.get(key);
    if (!existing || now > existing.expiresAt) {
      this.memoryCache.set(key, { count: 1, expiresAt: now + ttlSeconds * 1000 });
      return 1;
    }
    existing.count += 1;
    return existing.count;
  }

  private async deleteKey(key: string): Promise<void> {
    const client = this.redisService.getClient();
    if (client && client.status === "ready") {
      try {
        await client.del(key);
        return;
      } catch {
        // fallback
      }
    }
    this.memoryCache.delete(key);
  }
}
