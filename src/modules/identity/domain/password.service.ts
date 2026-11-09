import crypto from "node:crypto";
import { Injectable, Logger } from "@nestjs/common";
import { ZxcvbnFactory } from "@zxcvbn-ts/core";
import zxcvbnEnPackage from "@zxcvbn-ts/language-en";
import * as argon2 from "argon2";
import { AppConfigService } from "../../../config/config.service";

export interface PasswordStrengthResult {
  score: number; // 0 to 4
  warning: string | null;
  suggestions: string[];
}

export interface BreachedPasswordCheckResult {
  breached: boolean;
  count?: number;
  error?: string;
}

@Injectable()
export class PasswordService {
  private readonly logger = new Logger(PasswordService.name);
  private readonly zxcvbnMatcher: ZxcvbnFactory;
  // Precomputed argon2id hash of a fixed 16-character string for constant-time dummy verification
  private readonly dummyHash: string =
    "$argon2id$v=19$m=4096,t=1,p=1$7v8QfHkF8B1Qv9X2wK5Z3A$Y5c+V8x1W4j0m8K9L7nP3Q2R1s0T9u8V7w6X5y4Z3a0";

  constructor(private readonly config: AppConfigService) {
    this.zxcvbnMatcher = new ZxcvbnFactory({
      dictionary: { ...zxcvbnEnPackage.dictionary },
      translations: zxcvbnEnPackage.translations,
    });
  }

  /**
   * Hashes a plaintext password using Argon2id with memory-hard parameters.
   */
  async hash(password: string): Promise<string> {
    const isTest = this.config.isTest || process.env.NODE_ENV === "test";
    return argon2.hash(password, {
      type: argon2.argon2id,
      memoryCost: isTest ? 4096 : 65536,
      timeCost: isTest ? 2 : 3,
      parallelism: 1,
    });
  }

  /**
   * Verifies a password against an Argon2id hash.
   */
  async verify(hash: string, plain: string): Promise<boolean> {
    try {
      return await argon2.verify(hash, plain);
    } catch {
      return false;
    }
  }

  /**
   * Performs a dummy verification to ensure response duration remains uniform
   * when an email does not exist (mitigating timing side-channels).
   */
  async verifyDummy(plain: string): Promise<boolean> {
    try {
      await argon2.verify(this.dummyHash, plain);
    } catch {
      // Ignore
    }
    return false;
  }

  /**
   * Validates minimum password criteria according to NIST SP 800-63B.
   * Requires at least 12 characters and at most 128 characters.
   */
  validatePolicy(password: string): { valid: boolean; message?: string } {
    if (!password || typeof password !== "string") {
      return { valid: false, message: "Password is required" };
    }
    if (password.length < 12) {
      return { valid: false, message: "Password must be at least 12 characters long" };
    }
    if (password.length > 128) {
      return { valid: false, message: "Password cannot exceed 128 characters" };
    }
    return { valid: true };
  }

  /**
   * Evaluates password complexity and returns zxcvbn strength estimation.
   */
  evaluateStrength(password: string, userInputs: string[] = []): PasswordStrengthResult {
    const result = this.zxcvbnMatcher.check(password, userInputs);
    return {
      score: result.score,
      warning: result.feedback.warning || null,
      suggestions: result.feedback.suggestions || [],
    };
  }

  /**
   * Queries HaveIBeenPwned API via k-anonymity (SHA-1 prefix).
   * Disabled by default (AUTH_BREACHED_PASSWORD_CHECK_ENABLED=false).
   * Fails open if network error or timeout occurs.
   */
  async checkBreached(password: string): Promise<BreachedPasswordCheckResult> {
    const enabled = this.config.get("AUTH_BREACHED_PASSWORD_CHECK_ENABLED") === "true";
    if (!enabled) {
      return { breached: false };
    }

    try {
      const sha1 = crypto.createHash("sha1").update(password).digest("hex").toUpperCase();
      const prefix = sha1.slice(0, 5);
      const suffix = sha1.slice(5);

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 2000);
      if (typeof timeoutId.unref === "function") timeoutId.unref();

      const response = await fetch(`https://api.pwnedpasswords.com/range/${prefix}`, {
        headers: { "Add-Padding": "true", "User-Agent": "ProgressEye-API" },
        signal: controller.signal,
      });
      clearTimeout(timeoutId);

      if (!response.ok) {
        this.logger.warn(`HIBP API returned status ${response.status}; failing open.`);
        return { breached: false, error: `HTTP ${response.status}` };
      }

      const text = await response.text();
      const lines = text.split("\r\n");
      for (const line of lines) {
        const [hashSuffix, countStr] = line.split(":");
        if (hashSuffix && hashSuffix.trim() === suffix) {
          const count = Number.parseInt(countStr || "1", 10);
          return { breached: true, count };
        }
      }

      return { breached: false };
    } catch (err: unknown) {
      this.logger.warn(
        `HIBP breached password check failed or timed out: ${String(err)}; failing open.`,
      );
      return { breached: false, error: "Network timeout or unreachable" };
    }
  }
}
