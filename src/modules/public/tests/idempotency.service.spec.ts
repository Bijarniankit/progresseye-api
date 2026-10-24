import {
  BadRequestException,
  ConflictException,
  UnprocessableEntityException,
} from "@nestjs/common";
import { Test, type TestingModule } from "@nestjs/testing";
import { RedisService } from "../../../infra/redis/redis.service";
import { IdempotencyService } from "../domain/anti-abuse/idempotency.service";

describe("IdempotencyService", () => {
  let service: IdempotencyService;

  const mockRedisService = {
    getClient: jest.fn(() => null), // tests in-memory fallback semantics
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [IdempotencyService, { provide: RedisService, useValue: mockRedisService }],
    }).compile();

    service = module.get<IdempotencyService>(IdempotencyService);
    service.clearLocalCache();
  });

  describe("validateIdempotencyKey", () => {
    it("accepts valid UUID v4 strings", () => {
      const validKey = "550e8400-e29b-41d4-a716-446655440000";
      expect(service.validateIdempotencyKey(validKey)).toBe(validKey);
    });

    it("throws BadRequestException for non-UUID strings", () => {
      expect(() => service.validateIdempotencyKey("invalid-key-123")).toThrow(BadRequestException);
    });

    it("returns undefined when no key is provided", () => {
      expect(service.validateIdempotencyKey(undefined)).toBeUndefined();
    });
  });

  describe("Replay and Mismatch Semantics", () => {
    const key = "550e8400-e29b-41d4-a716-446655440000";
    const payload1 = { email: "test@school.edu.in", name: "User 1" };
    const payload2 = { email: "other@school.edu.in", name: "User 2" };

    it("acquires lock on initial request, then returns cached response on identical replay", async () => {
      const hash1 = service.computePayloadHash(payload1);

      // 1. Initial attempt
      const check1 = await service.checkOrLock(key, hash1);
      expect(check1.isCached).toBe(false);

      // Store completion
      const mockResponse = {
        id: "receipt-123",
        status: "received" as const,
        message: "Success",
        createdAt: new Date().toISOString(),
      };
      await service.storeResponse(key, hash1, mockResponse);

      // 2. Replay with identical payload
      const check2 = await service.checkOrLock(key, hash1);
      expect(check2.isCached).toBe(true);
      expect(check2.cachedResponse).toEqual(mockResponse);
    });

    it("throws 422 UnprocessableEntityException when same key is used with a different payload", async () => {
      const hash1 = service.computePayloadHash(payload1);
      const hash2 = service.computePayloadHash(payload2);

      // Store completion for payload 1
      const mockResponse = {
        id: "receipt-123",
        status: "received" as const,
        message: "Success",
        createdAt: new Date().toISOString(),
      };
      await service.storeResponse(key, hash1, mockResponse);

      // Attempt with payload 2 using the same key
      await expect(service.checkOrLock(key, hash2)).rejects.toThrow(UnprocessableEntityException);
    });

    it("throws 409 ConflictException when a concurrent duplicate is currently in-flight", async () => {
      const hash1 = service.computePayloadHash(payload1);

      // First request acquires processing lock
      await service.checkOrLock(key, hash1);

      // Second concurrent request before completion
      await expect(service.checkOrLock(key, hash1)).rejects.toThrow(ConflictException);
    });
  });
});
