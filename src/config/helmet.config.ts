import type { FastifyHelmetOptions } from "@fastify/helmet";

export const getHelmetConfig = (
  appEnv = process.env.APP_ENV || "development",
): FastifyHelmetOptions => {
  const isProduction = appEnv === "production";

  return {
    contentSecurityPolicy: {
      reportOnly: true,
      directives: {
        defaultSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        fontSrc: ["'self'"],
        imgSrc: ["'self'", "data:"],
        scriptSrc: ["'self'"],
        frameAncestors: ["'none'"],
      },
    },
    hsts: {
      // Configurable via HSTS_MAX_AGE_SECONDS env var.
      // 5 min (300s) initial ramp in production per rollout runbook; 1 day (86400s) on staging/dev.
      // Explicitly NO preload and NO includeSubDomains until custom domain is finalized.
      maxAge: process.env.HSTS_MAX_AGE_SECONDS
        ? Number.parseInt(process.env.HSTS_MAX_AGE_SECONDS, 10)
        : isProduction
          ? 300
          : 86400,
      includeSubDomains: false,
      preload: false,
    },
    frameguard: { action: "deny" },
  };
};
