import { z } from "zod";

export const CLOUDFLARE_TEST_SECRETS = [
  "1x0000000000000000000000000000000AA",
  "2x0000000000000000000000000000000AA",
  "3x0000000000000000000000000000000AA",
] as const;

export const baseEnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  APP_ENV: z.enum(["development", "staging", "production", "test"]).default("development"),
  PORT: z.coerce.number().default(4000),
  API_PREFIX: z.string().default("/api/v1"),
  CORS_ORIGIN: z.string().default("http://localhost:3000"),

  // Reverse Proxy configuration
  // Default is 0 (trustProxy: false) to prevent client IP spoofing when API is directly exposed.
  // Set TRUSTED_PROXY_COUNT > 0 (e.g. 1 behind AWS ALB/Cloudflare) or TRUSTED_PROXIES (CIDR list).
  TRUSTED_PROXY_COUNT: z.coerce.number().int().min(0).default(0),
  TRUSTED_PROXIES: z.string().optional(),

  // Database (Supabase PostgreSQL / Direct)
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  DIRECT_URL: z.string().optional(),

  // Supabase metadata (optional for Phase 2, ready for Supabase integration)
  SUPABASE_URL: z.string().optional(),
  SUPABASE_ANON_KEY: z.string().optional(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().optional(),

  // Redis
  REDIS_HOST: z.string().default("localhost"),
  REDIS_PORT: z.coerce.number().default(6379),
  REDIS_PASSWORD: z.string().optional(),

  // Throttler
  THROTTLE_TTL: z.coerce.number().default(60000),
  THROTTLE_LIMIT: z.coerce.number().default(100),

  // Logging
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),

  // Auth secrets (defaults provided for development/test if not specified)
  JWT_ACCESS_SECRET: z.string().min(16).default("progress-eye-dev-access-secret-32ch"),
  JWT_REFRESH_SECRET: z.string().min(16).default("progress-eye-dev-refresh-secret-32c"),

  // Public Leads & Anti-Abuse
  LEAD_IP_HMAC_SECRET: z.string().default("dev-lead-ip-hmac-secret"),
  TURNSTILE_ENABLED: z.string().default("false"),
  TURNSTILE_SECRET_KEY: z.string().default("1x0000000000000000000000000000000AA"),

  // HSTS configuration override (in seconds)
  HSTS_MAX_AGE_SECONDS: z.coerce.number().int().nonnegative().optional(),
  HSTS_INCLUDE_SUBDOMAINS: z.enum(["true", "false"]).optional(),
  HSTS_PRELOAD: z.enum(["true", "false"]).optional(),

  // Diagnostics (staging/dev only)
  DIAGNOSTICS_ENABLED: z.coerce.boolean().default(false),

  // Email & Notifications (Mailpit locally: localhost:1025)
  SMTP_HOST: z.string().default("localhost"),
  SMTP_PORT: z.coerce.number().default(1025),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  MAIL_FROM: z.string().default("noreply@progresseye.in"),
  LEAD_NOTIFICATION_RECIPIENT: z.string().default("leads@progresseye.in"),
});

export const envSchema = baseEnvSchema.superRefine((data, ctx) => {
  const isProduction = data.APP_ENV === "production" || data.NODE_ENV === "production";
  if (isProduction) {
    if (data.DIAGNOSTICS_ENABLED === true) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["DIAGNOSTICS_ENABLED"],
        message: "DIAGNOSTICS_ENABLED cannot be true when APP_ENV is production.",
      });
    }

    if (data.TURNSTILE_ENABLED !== "true") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["TURNSTILE_ENABLED"],
        message:
          "TURNSTILE_ENABLED must be 'true' in production environment (fail-closed anti-abuse enforcement).",
      });
    }

    if (
      !data.TURNSTILE_SECRET_KEY ||
      (CLOUDFLARE_TEST_SECRETS as readonly string[]).includes(data.TURNSTILE_SECRET_KEY)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["TURNSTILE_SECRET_KEY"],
        message:
          "TURNSTILE_SECRET_KEY cannot be empty or a Cloudflare test key in production. See https://developers.cloudflare.com/turnstile/troubleshooting/testing/",
      });
    }
  }
});

export type Env = z.infer<typeof baseEnvSchema>;

export function validateEnv(config: Record<string, unknown> = process.env): Env {
  const result = envSchema.safeParse(config);
  if (!result.success) {
    const errorDetails = result.error.issues
      .map((err) => `  - ${err.path.join(".")}: ${err.message}`)
      .join("\n");
    throw new Error(
      `\n❌ Configuration validation failed:\n${errorDetails}\n\nPlease check your .env configuration file.\n`,
    );
  }
  return result.data;
}
