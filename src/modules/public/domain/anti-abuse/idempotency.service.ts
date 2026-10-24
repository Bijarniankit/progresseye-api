import * as crypto from "node:crypto";
import {
  BadRequestException,
  ConflictException,
  Injectable,
  UnprocessableEntityException,
} from "@nestjs/common";
import { RedisService } from "../../../../infra/redis/redis.service";
import type { PublicLeadResponseDto } from "../../dto";

export interface IdempotencyEntry {
  status: "processing" | "completed";
  payloadHash: string;
  response?: PublicLeadResponseDto;
}

export interface IdempotencyCheckResult {
  isCached: boolean;
  cachedResponse?: PublicLeadResponseDto;
}

@Injectable()
export class IdempotencyService {
  private readonly ttlSeconds = 86400; // 24 hours
  private readonly lockTtlSeconds = 60; // 60 seconds processing lock

  // In-memory fallback map for unit tests and local dev when Redis container is not running
  private readonly localMemoryFallback = new Map<
    string,
    { entry: IdempotencyEntry; expiresAt: number }
  >();

  constructor(private readonly redisService: RedisService) {}

  public computePayloadHash(payload: unknown): string {
    const canonicalJson = JSON.stringify(payload, Object.keys(payload as object).sort());
    return crypto.createHash("sha256").update(canonicalJson).digest("hex");
  }

  public validateIdempotencyKey(key?: string): string | undefined {
    if (!key) return undefined;
    const trimmed = key.trim();
    // Validate UUID format
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    if (!uuidRegex.test(trimmed)) {
      throw new BadRequestException("Idempotency-Key must be a valid UUID v4");
    }
    return trimmed;
  }

  async checkOrLock(key: string, payloadHash: string): Promise<IdempotencyCheckResult> {
    const redis = this.redisService.getClient();
    const redisKey = `idempotency:lead:${key}`;

    if (redis && redis.status === "ready") {
      const existingRaw = await redis.get(redisKey);
      if (existingRaw) {
        const existing: IdempotencyEntry = JSON.parse(existingRaw);

        if (existing.payloadHash !== payloadHash) {
          throw new UnprocessableEntityException(
            "Idempotency key has already been used with a different request payload",
          );
        }

        if (existing.status === "processing") {
          throw new ConflictException(
            "Concurrent request with the same Idempotency-Key is currently in progress",
          );
        }

        if (existing.status === "completed" && existing.response) {
          return { isCached: true, cachedResponse: existing.response };
        }
      }

      // Acquire lock with SET NX
      const lockData: IdempotencyEntry = {
        status: "processing",
        payloadHash,
      };
      const acquired = await redis.set(
        redisKey,
        JSON.stringify(lockData),
        "EX",
        this.lockTtlSeconds,
        "NX",
      );

      if (!acquired) {
        // Another thread won the race
        const currentRaw = await redis.get(redisKey);
        if (currentRaw) {
          const current: IdempotencyEntry = JSON.parse(currentRaw);
          if (current.payloadHash !== payloadHash) {
            throw new UnprocessableEntityException(
              "Idempotency key has already been used with a different request payload",
            );
          }
          if (current.status === "completed" && current.response) {
            return { isCached: true, cachedResponse: current.response };
          }
        }
        throw new ConflictException(
          "Concurrent request with the same Idempotency-Key is currently in progress",
        );
      }

      return { isCached: false };
    }

    // In-memory fallback for local test execution without Redis
    const now = Date.now();
    const cached = this.localMemoryFallback.get(redisKey);
    if (cached && cached.expiresAt > now) {
      if (cached.entry.payloadHash !== payloadHash) {
        throw new UnprocessableEntityException(
          "Idempotency key has already been used with a different request payload",
        );
      }
      if (cached.entry.status === "processing") {
        throw new ConflictException(
          "Concurrent request with the same Idempotency-Key is currently in progress",
        );
      }
      if (cached.entry.status === "completed" && cached.entry.response) {
        return { isCached: true, cachedResponse: cached.entry.response };
      }
    }

    this.localMemoryFallback.set(redisKey, {
      entry: { status: "processing", payloadHash },
      expiresAt: now + this.lockTtlSeconds * 1000,
    });
    return { isCached: false };
  }

  async storeResponse(
    key: string,
    payloadHash: string,
    response: PublicLeadResponseDto,
  ): Promise<void> {
    const redis = this.redisService.getClient();
    const redisKey = `idempotency:lead:${key}`;
    const completedEntry: IdempotencyEntry = {
      status: "completed",
      payloadHash,
      response,
    };

    if (redis && redis.status === "ready") {
      await redis.set(redisKey, JSON.stringify(completedEntry), "EX", this.ttlSeconds);
      return;
    }

    // In-memory fallback
    this.localMemoryFallback.set(redisKey, {
      entry: completedEntry,
      expiresAt: Date.now() + this.ttlSeconds * 1000,
    });
  }

  // Clear memory cache between unit tests
  public clearLocalCache(): void {
    this.localMemoryFallback.clear();
  }
}
