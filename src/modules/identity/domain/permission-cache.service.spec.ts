import { Logger } from "@nestjs/common";
import { RedisService } from "../../../infra/redis/redis.service";
import { PermissionCacheService } from "./permission-cache.service";

describe("PermissionCacheService", () => {
  let service: PermissionCacheService;
  let mockRedisClient: any;
  let redisStore: Map<string, string>;

  beforeEach(() => {
    redisStore = new Map();

    mockRedisClient = {
      status: "ready",
      get: jest.fn().mockImplementation(async (key: string) => redisStore.get(key) || null),
      setex: jest.fn().mockImplementation(async (key: string, _ttl: number, val: string) => {
        redisStore.set(key, val);
        return "OK";
      }),
      del: jest.fn().mockImplementation(async (...keys: string[]) => {
        for (const k of keys) {
          redisStore.delete(k);
        }
        return keys.length;
      }),
    };

    const mockRedisService = {
      getClient: jest.fn().mockReturnValue(mockRedisClient),
    } as unknown as RedisService;

    service = new PermissionCacheService(mockRedisService);
  });

  it("should return cached permissions on cache hit", async () => {
    redisStore.set("auth:perm:sch-1:u-1", JSON.stringify(["identity.role.read"]));

    const result = await service.get("sch-1", "u-1");
    expect(result).toEqual(["identity.role.read"]);
  });

  it("should return null on cache miss", async () => {
    const result = await service.get("sch-1", "u-1");
    expect(result).toBeNull();
  });

  it("should fallback to null gracefully when Redis client is not ready or throws", async () => {
    mockRedisClient.status = "reconnecting";

    const result = await service.get("sch-1", "u-1");
    expect(result).toBeNull();
  });

  it("should fallback to null when Redis get times out (>250ms)", async () => {
    // Simulate a hung Redis get call
    mockRedisClient.get.mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve("never"), 350)),
    );

    const result = await service.get("sch-1", "u-1");
    expect(result).toBeNull();
  });

  it("should cache permissions with set", async () => {
    await service.set("sch-1", "u-1", ["identity.user.read", "identity.user.update"]);

    expect(mockRedisClient.setex).toHaveBeenCalledWith(
      "auth:perm:sch-1:u-1",
      900,
      JSON.stringify(["identity.user.read", "identity.user.update"]),
    );
  });

  it("should clear timer handle and handle timeout gracefully in set()", async () => {
    mockRedisClient.setex.mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve("OK"), 350)),
    );

    await expect(service.set("sch-1", "u-1", ["identity.user.read"])).resolves.not.toThrow();
  });

  it("should evict single user cache", async () => {
    redisStore.set("auth:perm:sch-1:u-1", JSON.stringify(["test"]));
    await service.evictUser("sch-1", "u-1");

    expect(redisStore.has("auth:perm:sch-1:u-1")).toBe(false);
  });

  it("should throw and log at ERROR level when evictUser fails", async () => {
    mockRedisClient.del.mockRejectedValue(new Error("Redis connection closed"));
    const errorSpy = jest.spyOn(Logger.prototype, "error").mockImplementation();

    await expect(service.evictUser("sch-1", "u-1")).rejects.toThrow("Redis connection closed");
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it("should throw and log at ERROR level when evictUser called with disconnected client", async () => {
    mockRedisClient.status = "disconnected";
    const errorSpy = jest.spyOn(Logger.prototype, "error").mockImplementation();

    await expect(service.evictUser("sch-1", "u-1")).rejects.toThrow(
      "Redis client not available for cache eviction",
    );
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it("should evict multiple users cache on role modification", async () => {
    redisStore.set("auth:perm:sch-1:u-1", JSON.stringify(["test1"]));
    redisStore.set("auth:perm:sch-1:u-2", JSON.stringify(["test2"]));

    await service.evictUsers("sch-1", ["u-1", "u-2"]);

    expect(redisStore.has("auth:perm:sch-1:u-1")).toBe(false);
    expect(redisStore.has("auth:perm:sch-1:u-2")).toBe(false);
  });

  it("should throw and log at ERROR level when evictUsers fails", async () => {
    mockRedisClient.del.mockRejectedValue(new Error("Cluster down"));
    const errorSpy = jest.spyOn(Logger.prototype, "error").mockImplementation();

    await expect(service.evictUsers("sch-1", ["u-1", "u-2"])).rejects.toThrow("Cluster down");
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});
