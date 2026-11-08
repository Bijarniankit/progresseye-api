import { HttpException, HttpStatus, UnauthorizedException } from "@nestjs/common";
import { Test, type TestingModule } from "@nestjs/testing";
import { AppConfigService } from "../../../config/config.service";
import { RedisService } from "../../../infra/redis/redis.service";
import { AbusePreventionService } from "./abuse-prevention.service";

describe("AbusePreventionService", () => {
  let service: AbusePreventionService;

  beforeEach(async () => {
    const mockConfig = {
      get: jest.fn().mockImplementation((key: string) => {
        if (key === "AUTH_LOG_HMAC_SECRET") return "test-log-hmac-secret-min16ch";
        if (key === "AUTH_JWT_SECRET") return "test-jwt-secret-at-least-32-chars-long!";
        return undefined;
      }),
    };

    const mockRedis = {
      getClient: jest.fn().mockReturnValue(null), // Uses in-memory fallback for unit tests
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AbusePreventionService,
        {
          provide: AppConfigService,
          useValue: mockConfig,
        },
        {
          provide: RedisService,
          useValue: mockRedis,
        },
      ],
    }).compile();

    service = module.get<AbusePreventionService>(AbusePreventionService);
  });

  describe("Anti-DoS Account + IP Lockout (Amendment 3)", () => {
    const schoolId = "018f0000-0000-7000-8000-000000000001";
    const victimEmail = "victim@school.com";
    const attackerIp = "198.51.100.1";
    const legitimateIp = "203.0.113.5";

    it("should lock out only the offending IP after 5 failed attempts without locking out the legitimate user on another IP", async () => {
      // 1. Initial state: both IPs can attempt login
      await expect(service.checkPreLogin(attackerIp, victimEmail, schoolId)).resolves.not.toThrow();
      await expect(
        service.checkPreLogin(legitimateIp, victimEmail, schoolId),
      ).resolves.not.toThrow();

      // 2. Attacker fails 5 times against victim account
      for (let i = 0; i < 5; i++) {
        await service.recordFailedLogin(attackerIp, victimEmail, schoolId);
      }

      // 3. Attacker IP is now locked out for victim's account (returns generic 401)
      await expect(service.checkPreLogin(attackerIp, victimEmail, schoolId)).rejects.toThrow(
        UnauthorizedException,
      );

      // 4. CRITICAL INVARIANT: Legitimate user on legitimate IP is NOT locked out!
      await expect(
        service.checkPreLogin(legitimateIp, victimEmail, schoolId),
      ).resolves.not.toThrow();
    });

    it("should reset lockout counter after successful login", async () => {
      // Record 3 failures
      await service.recordFailedLogin(attackerIp, victimEmail, schoolId);
      await service.recordFailedLogin(attackerIp, victimEmail, schoolId);
      await service.recordFailedLogin(attackerIp, victimEmail, schoolId);

      // Successful login resets counter
      await service.recordSuccessfulLogin(attackerIp, victimEmail, schoolId);

      // Can make 4 more attempts without being locked out
      for (let i = 0; i < 4; i++) {
        await service.recordFailedLogin(attackerIp, victimEmail, schoolId);
      }
      await expect(service.checkPreLogin(attackerIp, victimEmail, schoolId)).resolves.not.toThrow();
    });
  });

  describe("Per-IP Global Rate Limiting", () => {
    const schoolId = "018f0000-0000-7000-8000-000000000001";
    const spammerIp = "192.0.2.99";

    it("should reject with 429 Too Many Requests when IP exceeds 20 failed attempts across different accounts", async () => {
      // Spammer tries 20 different accounts from the same IP
      for (let i = 1; i <= 20; i++) {
        await service.recordFailedLogin(spammerIp, `user${i}@school.com`, schoolId);
      }

      // 21st attempt from spammer IP is blocked with 429
      await expect(
        service.checkPreLogin(spammerIp, "another@school.com", schoolId),
      ).rejects.toThrow(HttpException);

      try {
        await service.checkPreLogin(spammerIp, "another@school.com", schoolId);
      } catch (err: any) {
        expect(err.getStatus()).toBe(HttpStatus.TOO_MANY_REQUESTS);
        expect(err.getResponse().message).toMatch(/Too many authentication attempts/);
      }
    });
  });

  describe("Per-Account Across-IP Cap (Progressive Delay, No Hard Lock)", () => {
    const schoolId = "018f0000-0000-7000-8000-000000000001";
    const victimEmail = "rotating-botnet-target@school.com";

    it("should throttle rotating IP attacks against single account with progressive delay without hard lockout", async () => {
      // 5 different IPs attempt 1 failed login each (no single IP hits the 5-attempt pair limit)
      for (let i = 1; i <= 5; i++) {
        await service.recordFailedLogin(`198.51.100.${i}`, victimEmail, schoolId);
      }

      // Next attempt from a 6th IP experiences progressive delay, but is NOT hard-locked
      const start = Date.now();
      await expect(
        service.checkPreLogin("198.51.100.6", victimEmail, schoolId),
      ).resolves.not.toThrow();
      const elapsed = Date.now() - start;

      // Assert progressive delay occurred (>= 150ms)
      expect(elapsed).toBeGreaterThanOrEqual(150);
    });
  });

  describe("Successor Token Grace Window Caching (Amendment 4)", () => {
    it("should cache and retrieve successor tokens within TTL", async () => {
      const tokenHash = "dummy-token-hash-12345";
      const successorData = {
        accessToken: "new-access-token",
        expiresIn: 900,
        compoundRefreshToken: "school.new-refresh-token",
      };

      // Not cached initially
      const initial = await service.getSuccessorToken(tokenHash);
      expect(initial).toBeNull();

      // Cache for 10 seconds
      await service.cacheSuccessorToken(tokenHash, successorData, 10);

      // Retrieved successfully
      const cached = await service.getSuccessorToken(tokenHash);
      expect(cached).toBeDefined();
      expect(cached?.accessToken).toBe("new-access-token");
      expect(cached?.compoundRefreshToken).toBe("school.new-refresh-token");
    });
  });
});
