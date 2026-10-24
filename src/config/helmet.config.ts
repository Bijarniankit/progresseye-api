import type { FastifyHelmetOptions } from "@fastify/helmet";

export const getHelmetConfig = (
  _appEnv = process.env.APP_ENV || "development",
): FastifyHelmetOptions => {
  return {
    contentSecurityPolicy: {
      reportOnly: true,
      directives: {
        defaultSrc: ["'self'"],
        styleSrc: [
          "'self'",
          "'unsafe-inline'",
          "https://cdn.jsdelivr.net",
          "https://fonts.googleapis.com",
        ],
        fontSrc: ["'self'", "https://fonts.gstatic.com"],
        imgSrc: ["'self'", "data:", "https:"],
        scriptSrc: ["'self'", "'unsafe-inline'", "https://cdn.jsdelivr.net"],
      },
    },
    hsts: {
      maxAge: 86400, // 1 day short max-age for staging / initial rollout (no preload, no includeSubDomains)
      includeSubDomains: false,
      preload: false,
    },
    frameguard: { action: "deny" },
  };
};
