import { validateEnv } from "./env.schema";

describe("Environment Configuration Validation", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it("should fail validation with clear error message when required variables are missing", () => {
    expect(() => validateEnv({})).toThrow(/Configuration validation failed:.*DATABASE_URL/s);
  });

  it("should succeed and apply sensible defaults when valid configuration is provided", () => {
    const validConfig = {
      DATABASE_URL: "postgresql://postgres:postgres@localhost:5432/test_db",
    };

    const env = validateEnv(validConfig);
    expect(env.DATABASE_URL).toBe(validConfig.DATABASE_URL);
    expect(env.PORT).toBe(4000);
    expect(env.API_PREFIX).toBe("/api/v1");
    expect(env.THROTTLE_LIMIT).toBe(100);
    expect(env.THROTTLE_TTL).toBe(60000);
    expect(env.LOG_LEVEL).toBe("info");
    expect(env.TRUSTED_PROXY_COUNT).toBe(0);
    expect(env.TRUSTED_PROXIES).toBeUndefined();
  });

  describe("Turnstile Fail-Closed Enforcement in Production", () => {
    const baseProdConfig = {
      APP_ENV: "production",
      NODE_ENV: "production",
      DATABASE_URL: "postgresql://postgres:postgres@localhost:5432/prod_db",
    };

    it("should reject startup in production if TURNSTILE_ENABLED is not 'true'", () => {
      expect(() =>
        validateEnv({
          ...baseProdConfig,
          TURNSTILE_ENABLED: "false",
        }),
      ).toThrow(/TURNSTILE_ENABLED must be 'true' in production environment/);
    });

    it("should reject startup in production if TURNSTILE_SECRET_KEY is the 1x test secret", () => {
      expect(() =>
        validateEnv({
          ...baseProdConfig,
          TURNSTILE_ENABLED: "true",
          TURNSTILE_SECRET_KEY: "1x0000000000000000000000000000000AA",
        }),
      ).toThrow(/TURNSTILE_SECRET_KEY cannot be empty or a Cloudflare test key in production/);
    });

    it("should reject startup in production if TURNSTILE_SECRET_KEY is the 2x or 3x test secret", () => {
      expect(() =>
        validateEnv({
          ...baseProdConfig,
          TURNSTILE_ENABLED: "true",
          TURNSTILE_SECRET_KEY: "2x0000000000000000000000000000000AA",
        }),
      ).toThrow(/https:\/\/developers\.cloudflare\.com\/turnstile\/troubleshooting\/testing\//);

      expect(() =>
        validateEnv({
          ...baseProdConfig,
          TURNSTILE_ENABLED: "true",
          TURNSTILE_SECRET_KEY: "3x0000000000000000000000000000000AA",
        }),
      ).toThrow(/https:\/\/developers\.cloudflare\.com\/turnstile\/troubleshooting\/testing\//);
    });

    it("should succeed in production when TURNSTILE_ENABLED is 'true' and a non-test secret key is provided", () => {
      const env = validateEnv({
        ...baseProdConfig,
        TURNSTILE_ENABLED: "true",
        TURNSTILE_SECRET_KEY: "0x4AAAAAAAxRealCloudflareSecretKeyExample",
      });
      expect(env.APP_ENV).toBe("production");
      expect(env.TURNSTILE_ENABLED).toBe("true");
      expect(env.TURNSTILE_SECRET_KEY).toBe("0x4AAAAAAAxRealCloudflareSecretKeyExample");
    });
  });
});
