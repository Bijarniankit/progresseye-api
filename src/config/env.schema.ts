import { z } from "zod";

export const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().default(4000),
  API_PREFIX: z.string().default("/api/v1"),
  CORS_ORIGIN: z.string().default("http://localhost:3000"),

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

  // Email & Notifications (Mailpit locally: localhost:1025)
  SMTP_HOST: z.string().default("localhost"),
  SMTP_PORT: z.coerce.number().default(1025),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  MAIL_FROM: z.string().default("noreply@progresseye.com"),
  LEAD_NOTIFICATION_RECIPIENT: z.string().default("leads@progresseye.com"),
});

export type Env = z.infer<typeof envSchema>;

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
