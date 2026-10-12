import { Injectable } from "@nestjs/common";
import { type Env, validateEnv } from "./env.schema";

@Injectable()
export class AppConfigService {
  private readonly env: Env;

  constructor() {
    this.env = validateEnv(process.env);
  }

  get<K extends keyof Env>(key: K): Env[K] {
    return this.env[key];
  }

  get isProduction(): boolean {
    return this.env.NODE_ENV === "production";
  }

  get isDevelopment(): boolean {
    return this.env.NODE_ENV === "development";
  }

  get isTest(): boolean {
    return this.env.NODE_ENV === "test";
  }

  getAll(): Readonly<Env> {
    return Object.freeze({ ...this.env });
  }
}
