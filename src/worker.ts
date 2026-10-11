import { Worker } from "bullmq";

async function bootstrapWorker() {
  const redisHost = process.env.REDIS_HOST || "localhost";
  const redisPort = Number(process.env.REDIS_PORT) || 6379;

  console.log(
    `ProgressEye BullMQ Worker starting... connecting to Redis at ${redisHost}:${redisPort}`,
  );

  // Workers will register handlers in subsequent phases
}

bootstrapWorker().catch((err) => {
  console.error("Worker failed to start:", err);
  process.exit(1);
});
