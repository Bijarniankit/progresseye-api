import { Test, type TestingModule } from "@nestjs/testing";
import { RedisService } from "../../../infra/redis/redis.service";
import { ThrottlerStorageRedisService } from "../../../infra/redis/throttler-storage-redis.service";

describe("Rate Limiting Storage & Thresholds", () => {
  let storage: ThrottlerStorageRedisService;

  const mockRedisService = {
    getClient: jest.fn(() => null), // tests in-memory tracking logic
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ThrottlerStorageRedisService,
        { provide: RedisService, useValue: mockRedisService },
      ],
    }).compile();

    storage = module.get<ThrottlerStorageRedisService>(ThrottlerStorageRedisService);
    storage.clearLocalCounters();
  });

  describe("Contact & Demo Rate Limits (5 requests / 15 min)", () => {
    const ip = "198.51.100.42";
    const key = `contact:${ip}`;
    const ttl = 900000; // 15 minutes in ms
    const limit = 5;

    it("allows the first 5 requests and blocks the 6th request with timeToBlockExpire", async () => {
      // First 5 requests must pass
      for (let i = 1; i <= limit; i++) {
        const record = await storage.increment(key, ttl, limit, 0, "default");
        expect(record.totalHits).toBe(i);
        expect(record.isBlocked).toBe(false);
      }

      // 6th request must be blocked
      const blockedRecord = await storage.increment(key, ttl, limit, 0, "default");
      expect(blockedRecord.totalHits).toBe(6);
      expect(blockedRecord.isBlocked).toBe(true);
      expect(blockedRecord.timeToBlockExpire).toBeGreaterThan(0);
    });
  });

  describe("Newsletter Rate Limits (10 requests / 15 min)", () => {
    const ip = "198.51.100.43";
    const key = `newsletter:${ip}`;
    const ttl = 900000; // 15 minutes in ms
    const limit = 10;

    it("allows the first 10 requests and blocks the 11th request", async () => {
      for (let i = 1; i <= limit; i++) {
        const record = await storage.increment(key, ttl, limit, 0, "default");
        expect(record.totalHits).toBe(i);
        expect(record.isBlocked).toBe(false);
      }

      const blockedRecord = await storage.increment(key, ttl, limit, 0, "default");
      expect(blockedRecord.totalHits).toBe(11);
      expect(blockedRecord.isBlocked).toBe(true);
    });
  });

  describe("Isolated Counters Between Cases", () => {
    it("clearing counters resets all tracked IPs", async () => {
      const key = "test:198.51.100.99";
      await storage.increment(key, 900000, 5, 0, "default");
      await storage.increment(key, 900000, 5, 0, "default");

      storage.clearLocalCounters();

      const freshRecord = await storage.increment(key, 900000, 5, 0, "default");
      expect(freshRecord.totalHits).toBe(1);
      expect(freshRecord.isBlocked).toBe(false);
    });
  });
});
