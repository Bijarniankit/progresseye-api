import { validateEnv } from "./config/env.schema";

async function bootstrapWorker() {
  const env = validateEnv(process.env);
  const redisHost = env.REDIS_HOST;
  const redisPort = env.REDIS_PORT;

  console.log(
    `[ProgressEye Worker] Starting background worker... Redis: ${redisHost}:${redisPort}`,
  );

  const shutdown = async (signal: string) => {
    console.log(`[ProgressEye Worker] Received ${signal}, shutting down gracefully...`);
    process.exit(0);
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  console.log("[ProgressEye Worker] Worker ready for queue processors.");
}

bootstrapWorker().catch((err) => {
  console.error("[ProgressEye Worker] Fatal worker boot error:", err);
  process.exit(1);
});
