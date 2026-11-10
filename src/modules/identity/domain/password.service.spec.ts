import { Test, type TestingModule } from "@nestjs/testing";
import { AppConfigService } from "../../../config/config.service";
import { PasswordService } from "./password.service";

describe("PasswordService", () => {
  let service: PasswordService;
  let mockConfig: {
    get: jest.Mock;
    isTest: boolean;
    isProduction: boolean;
  };

  beforeEach(async () => {
    mockConfig = {
      get: jest.fn().mockImplementation((key: string) => {
        if (key === "AUTH_BREACHED_PASSWORD_CHECK_ENABLED") return "false";
        return undefined;
      }),
      isTest: true,
      isProduction: false,
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PasswordService,
        {
          provide: AppConfigService,
          useValue: mockConfig,
        },
      ],
    }).compile();

    service = module.get<PasswordService>(PasswordService);
  });

  describe("Argon2id Hashing & Verification", () => {
    it("should hash a password and verify it successfully", async () => {
      const password = "SuperSecretPassword2026!";
      const hash = await service.hash(password);

      expect(hash).toMatch(/^\$argon2id\$/);
      const isValid = await service.verify(hash, password);
      expect(isValid).toBe(true);

      const isInvalid = await service.verify(hash, "WrongPassword123!");
      expect(isInvalid).toBe(false);
    });

    it("should return false on verifyDummy without throwing", async () => {
      const res = await service.verifyDummy("AnyPasswordAttempt");
      expect(res).toBe(false);
    });

    it("should exhibit comparable latency between verify and verifyDummy (coarse timing test)", async () => {
      const password = "TargetPassword2026!";
      const hash = await service.hash(password);

      // Warmup to avoid JIT / thread-pool initialization jitter
      await service.verify(hash, "WarmupPassword!");
      await service.verifyDummy("WarmupPassword!");

      // Measure 5 samples of verify with wrong password
      const wrongPassTimes: number[] = [];
      for (let i = 0; i < 5; i++) {
        const start = performance.now();
        await service.verify(hash, "IncorrectPasswordGuess!");
        wrongPassTimes.push(performance.now() - start);
      }

      // Measure 5 samples of verifyDummy (unknown user / unknown school path)
      const dummyTimes: number[] = [];
      for (let i = 0; i < 5; i++) {
        const start = performance.now();
        await service.verifyDummy("IncorrectPasswordGuess!");
        dummyTimes.push(performance.now() - start);
      }

      const avgWrong = wrongPassTimes.reduce((a, b) => a + b, 0) / wrongPassTimes.length;
      const avgDummy = dummyTimes.reduce((a, b) => a + b, 0) / dummyTimes.length;

      // Loose tolerance factor (within loose bounds) to accommodate CI virtualization and GC pauses
      expect(avgDummy).toBeGreaterThan(0);
      expect(avgWrong).toBeGreaterThan(0);
      const ratio = avgDummy / avgWrong;
      expect(ratio).toBeGreaterThan(0.15);
      expect(ratio).toBeLessThan(6.0);
    });
  });

  describe("NIST SP 800-63B Password Policy", () => {
    it("should reject passwords shorter than 12 characters", () => {
      const res = service.validatePolicy("Short123!");
      expect(res.valid).toBe(false);
      expect(res.message).toMatch(/at least 12 characters/);
    });

    it("should reject passwords longer than 128 characters", () => {
      const longPass = "A".repeat(129);
      const res = service.validatePolicy(longPass);
      expect(res.valid).toBe(false);
      expect(res.message).toMatch(/cannot exceed 128 characters/);
    });

    it("should accept valid passwords >= 12 characters without requiring archaic composition rules", () => {
      const res = service.validatePolicy("correct horse battery staple");
      expect(res.valid).toBe(true);
    });
  });

  describe("zxcvbn Password Strength Estimation", () => {
    it("should rate weak passwords with low score", () => {
      const result = service.evaluateStrength("password12345");
      expect(result.score).toBeLessThanOrEqual(2);
      expect(result.suggestions.length).toBeGreaterThan(0);
    });

    it("should rate strong passphrases with high score", () => {
      const result = service.evaluateStrength("correct-horse-battery-staple-2026-secure");
      expect(result.score).toBe(4);
    });
  });

  describe("HaveIBeenPwned k-Anonymity Check", () => {
    it("should return breached: false when disabled", async () => {
      mockConfig.get.mockReturnValue("false");
      const res = await service.checkBreached("P@ssword123");
      expect(res.breached).toBe(false);
    });

    it("should parse HIBP response and detect breached password when enabled", async () => {
      mockConfig.get.mockReturnValue("true");
      // SHA-1 for "password": 5BAA61E4C9B93F3F0682250B6CF8331B7EE68FD8
      // Prefix: 5BAA6, Suffix: 1E4C9B93F3F0682250B6CF8331B7EE68FD8
      const mockResponseText =
        "0018A45C4D1def:2\r\n1E4C9B93F3F0682250B6CF8331B7EE68FD8:3860334\r\nFFF:1";

      const originalFetch = globalThis.fetch;
      globalThis.fetch = jest.fn().mockResolvedValue({
        ok: true,
        text: async () => mockResponseText,
      } as unknown as Response);

      try {
        const res = await service.checkBreached("password");
        expect(res.breached).toBe(true);
        expect(res.count).toBe(3860334);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it("should fail open if HIBP is unreachable or returns error", async () => {
      mockConfig.get.mockReturnValue("true");
      const originalFetch = globalThis.fetch;
      globalThis.fetch = jest.fn().mockRejectedValue(new Error("Network timeout"));

      try {
        const res = await service.checkBreached("password");
        expect(res.breached).toBe(false);
        expect(res.error).toBeDefined();
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });
});
