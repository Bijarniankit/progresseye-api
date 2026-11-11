import * as crypto from "node:crypto";
import { ServiceUnavailableException } from "@nestjs/common";
import type { AppConfigService } from "../../../config/config.service";
import type { RedisService } from "../../../infra/redis/redis.service";
import { base32Decode, base32Encode, TotpService } from "./totp.service";

describe("TotpService", () => {
  let service: TotpService;
  let mockConfig: Partial<AppConfigService>;
  let mockRedis: any;
  let redisStore: Map<string, string>;

  const mockEncKey = "test-totp-encryption-key-min-32-chars-long!";

  beforeEach(() => {
    redisStore = new Map<string, string>();
    mockRedis = {
      status: "ready",
      set: jest
        .fn()
        .mockImplementation(
          async (key: string, val: string, _mode: string, _ttl: number, flag?: string) => {
            if (flag === "NX" && redisStore.has(key)) {
              return null;
            }
            redisStore.set(key, val);
            return "OK";
          },
        ),
      get: jest.fn().mockImplementation(async (key: string) => redisStore.get(key) ?? null),
      del: jest.fn().mockImplementation(async (key: string) => {
        redisStore.delete(key);
        return 1;
      }),
      incr: jest.fn().mockImplementation(async (key: string) => {
        const current = parseInt(redisStore.get(key) ?? "0", 10);
        const next = current + 1;
        redisStore.set(key, next.toString());
        return next;
      }),
      expire: jest.fn().mockResolvedValue(1),
    };

    mockConfig = {
      get: jest.fn().mockImplementation((key: string) => {
        if (key === "AUTH_TOTP_ENC_KEY") return mockEncKey;
        return undefined;
      }),
    };

    const mockRedisService = {
      getClient: jest.fn().mockReturnValue(mockRedis),
    } as unknown as RedisService;

    service = new TotpService(mockConfig as AppConfigService, mockRedisService);
  });

  describe("Base32 Encoding & Decoding", () => {
    it("should round-trip encode and decode random buffers correctly", () => {
      const buffer = crypto.randomBytes(20);
      const encoded = base32Encode(buffer);
      expect(encoded.length).toBe(32);
      expect(encoded).toMatch(/^[A-Z2-7]+$/);

      const decoded = base32Decode(encoded);
      expect(decoded.equals(buffer)).toBe(true);
    });

    it("should throw error on invalid base32 characters during decode", () => {
      expect(() => base32Decode("INVALID1890")).toThrow(/Invalid base32 character/);
    });
  });

  describe("RFC 6238 TOTP Generation & Drift Window", () => {
    it("should generate a valid 6-digit TOTP code and verify at current step", () => {
      const setup = service.generateTotpSetup("user@example.com");
      expect(setup.secret).toBeTruthy();
      expect(setup.uri).toContain("otpauth://totp/");

      const now = Date.now();
      const code = service.generateCode(setup.secret, now);
      expect(code).toMatch(/^\d{6}$/);

      const matchedStep = service.verifyCodeWithoutReplay(setup.secret, code, now);
      expect(matchedStep).not.toBeNull();
      expect(matchedStep).toBe(Math.floor(now / 1000 / 30));
    });

    it("should accept codes within +/- 1 step drift window", () => {
      const setup = service.generateTotpSetup("user@example.com");
      const now = Date.now();
      const currentStep = Math.floor(now / 1000 / 30);

      // Previous step (-30s)
      const prevCode = service.generateCode(setup.secret, now - 30_000);
      const matchedPrev = service.verifyCodeWithoutReplay(setup.secret, prevCode, now);
      expect(matchedPrev).toBe(currentStep - 1);

      // Next step (+30s)
      const nextCode = service.generateCode(setup.secret, now + 30_000);
      const matchedNext = service.verifyCodeWithoutReplay(setup.secret, nextCode, now);
      expect(matchedNext).toBe(currentStep + 1);
    });

    it("should reject codes outside +/- 1 step window (+2 steps, -2 steps)", () => {
      const setup = service.generateTotpSetup("user@example.com");
      const now = Date.now();

      // -60s (-2 steps)
      const tooOldCode = service.generateCode(setup.secret, now - 60_000);
      expect(service.verifyCodeWithoutReplay(setup.secret, tooOldCode, now)).toBeNull();

      // +60s (+2 steps)
      const tooNewCode = service.generateCode(setup.secret, now + 60_000);
      expect(service.verifyCodeWithoutReplay(setup.secret, tooNewCode, now)).toBeNull();
    });
  });

  describe("TOTP Replay Protection via Redis SET NX", () => {
    it("should accept first verification and reject replay with identical step", async () => {
      const setup = service.generateTotpSetup("user@example.com");
      const now = Date.now();
      const code = service.generateCode(setup.secret, now);
      const userId = "01931a20-8e7c-7d9b-a012-3456789abcde";

      // 1. First verification succeeds
      const firstAttempt = await service.verifyTotpCode(userId, setup.secret, code, now);
      expect(firstAttempt).toBe(true);

      // 2. Replay with identical code and step fails
      const replayAttempt = await service.verifyTotpCode(userId, setup.secret, code, now);
      expect(replayAttempt).toBe(false);
    });

    it("should throw ServiceUnavailableException (503) when Redis is down during verify", async () => {
      const setup = service.generateTotpSetup("user@example.com");
      const now = Date.now();
      const code = service.generateCode(setup.secret, now);
      const userId = "01931a20-8e7c-7d9b-a012-3456789abcde";

      mockRedis.status = "end"; // Simulate offline Redis

      await expect(service.verifyTotpCode(userId, setup.secret, code, now)).rejects.toThrow(
        ServiceUnavailableException,
      );
    });
  });

  describe("AES-256-GCM Secret Encryption", () => {
    it("should encrypt and decrypt secret successfully", () => {
      const plainSecret = "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP";
      const encrypted = service.encryptSecret(plainSecret);

      expect(encrypted.encryptedSecret).toBeTruthy();
      expect(encrypted.iv).toHaveLength(24); // 12 bytes hex
      expect(encrypted.authTag).toHaveLength(32); // 16 bytes hex

      const decrypted = service.decryptSecret(
        encrypted.encryptedSecret,
        encrypted.iv,
        encrypted.authTag,
      );
      expect(decrypted).toBe(plainSecret);
    });

    it("should return null when decrypted with a wrong key (tamper protection)", () => {
      const plainSecret = "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP";
      const encrypted = service.encryptSecret(plainSecret);

      const wrongKey = crypto.randomBytes(32);
      const decrypted = service.decryptSecret(
        encrypted.encryptedSecret,
        encrypted.iv,
        encrypted.authTag,
        wrongKey,
      );
      expect(decrypted).toBeNull();
    });
  });

  describe("Recovery Codes Generation and Shared Attempt Cap", () => {
    it("should generate 8 formatted recovery codes and distinct SHA-256 hashes", () => {
      const { plainCodes, hashedCodes } = service.generateRecoveryCodes();
      expect(plainCodes).toHaveLength(8);
      expect(hashedCodes).toHaveLength(8);

      plainCodes.forEach((code, index) => {
        expect(code).toMatch(/^[A-Z2-7]{5}-[A-Z2-7]{5}$/);
        const expectedHash = service.hashRecoveryCode(code);
        expect(hashedCodes[index]).toBe(expectedHash);
      });
    });

    it("should enforce per-user attempt cap shared between TOTP and recovery codes", async () => {
      const userId = "01931a20-8e7c-7d9b-a012-3456789abcde";

      for (let i = 1; i <= 5; i++) {
        const allowed = await service.checkAndIncrementAttemptCap(userId);
        expect(allowed).toBe(true);
      }

      // 6th attempt is blocked
      const blocked = await service.checkAndIncrementAttemptCap(userId);
      expect(blocked).toBe(false);

      // Reset upon success
      await service.resetAttemptCap(userId);
      const allowedAfterReset = await service.checkAndIncrementAttemptCap(userId);
      expect(allowedAfterReset).toBe(true);
    });
  });
});
