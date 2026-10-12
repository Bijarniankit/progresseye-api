import { Injectable, type OnModuleDestroy, type OnModuleInit } from "@nestjs/common";
import Redis from "ioredis";
import { AppConfigService } from "../../config/config.service";

@Injectable()
export class RedisService implements OnModuleInit, OnModuleDestroy {
  private client: Redis | null = null;

  constructor(private readonly config: AppConfigService) {}

  onModuleInit(): void {
    const host = this.config.get("REDIS_HOST");
    const port = this.config.get("REDIS_PORT");
    const password = this.config.get("REDIS_PASSWORD");

    this.client = new Redis({
      host,
      port,
      password: password || undefined,
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      retryStrategy: () => null, // Do not spam retries if offline in local dev
    });

    // Quietly handle connection errors
    this.client.on("error", () => {});
  }

  async onModuleDestroy(): Promise<void> {
    if (this.client) {
      await this.client.quit().catch(() => {});
    }
  }

  getClient(): Redis | null {
    return this.client;
  }

  async ping(): Promise<boolean> {
    if (!this.client) return false;
    try {
      if (this.client.status !== "ready" && this.client.status !== "connecting") {
        await this.client.connect().catch(() => {});
      }
      const res = await this.client.ping();
      return res === "PONG";
    } catch {
      return false;
    }
  }
}
