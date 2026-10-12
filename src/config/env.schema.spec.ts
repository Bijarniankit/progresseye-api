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
  });
});
