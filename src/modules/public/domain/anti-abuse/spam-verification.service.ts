import { BadRequestException, Injectable, Logger } from "@nestjs/common";
import { ErrorCode } from "../../../../common/errors/error-codes.enum";
import { AppConfigService } from "../../../../config/config.service";

export interface SpamVerificationResult {
  success: boolean;
  errorCodes?: string[];
  errorMessage?: string;
}

export interface ISpamVerificationService {
  verifyToken(token?: string): Promise<SpamVerificationResult>;
}

export const SPAM_VERIFICATION_SERVICE = Symbol("SPAM_VERIFICATION_SERVICE");

/**
 * Cloudflare Turnstile Verification Service.
 *
 * Test Keys (per official Cloudflare documentation):
 * https://developers.cloudflare.com/turnstile/troubleshooting/testing/
 * - Always passes Secret Key: 1x0000000000000000000000000000000AA
 * - Always blocks Secret Key: 2x0000000000000000000000000000000AA
 * - Dummy pass token: 1x00000000000000000000AA
 *
 * Privacy Notice:
 * In compliance with data minimisation guidelines, client IP is NOT forwarded to Cloudflare.
 * Only the secret key and the turnstile token response are transmitted.
 */
@Injectable()
export class TurnstileService implements ISpamVerificationService {
  private readonly logger = new Logger(TurnstileService.name);
  private readonly siteverifyUrl = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
  private readonly timeoutMs = 5000;

  // Documented Cloudflare test keys
  public static readonly TEST_PASS_SECRET = "1x0000000000000000000000000000000AA";
  public static readonly TEST_BLOCK_SECRET = "2x0000000000000000000000000000000AA";
  public static readonly TEST_PASS_TOKEN = "1x00000000000000000000AA";

  constructor(private readonly config: AppConfigService) {}

  private isEnabled(): boolean {
    const enabled = this.config.get("TURNSTILE_ENABLED");
    return enabled === "true" || enabled === "1";
  }

  private getSecretKey(): string {
    return this.config.get("TURNSTILE_SECRET_KEY") || TurnstileService.TEST_PASS_SECRET;
  }

  async verifyToken(token?: string): Promise<SpamVerificationResult> {
    if (!this.isEnabled()) {
      return { success: true };
    }

    if (!token || token.trim().length === 0) {
      this.logger.warn("Turnstile verification failed: missing token");
      throw new BadRequestException({
        code: ErrorCode.SPAM_VERIFICATION_FAILED,
        message: "Spam verification token is required",
      });
    }

    const secret = this.getSecretKey();

    // Dev/Test mode fast-path: check Cloudflare documented test tokens
    if (secret === TurnstileService.TEST_BLOCK_SECRET) {
      this.logger.warn("Turnstile test block secret matched; rejecting token");
      throw new BadRequestException({
        code: ErrorCode.SPAM_VERIFICATION_FAILED,
        message: "Spam verification failed",
      });
    }

    if (
      token === TurnstileService.TEST_PASS_TOKEN ||
      secret === TurnstileService.TEST_PASS_SECRET
    ) {
      return { success: true };
    }

    // Call Cloudflare siteverify endpoint with fail-closed semantics
    try {
      const response = await fetch(this.siteverifyUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          secret,
          response: token,
          // Intentionally omitting remoteip to preserve client privacy
        }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });

      if (!response.ok) {
        this.logger.error(`Turnstile siteverify returned HTTP ${response.status}`);
        throw new BadRequestException({
          code: ErrorCode.SPAM_VERIFICATION_FAILED,
          message: "Spam verification failed",
        });
      }

      const outcome = (await response.json()) as {
        success: boolean;
        "error-codes"?: string[];
      };

      if (!outcome.success) {
        this.logger.warn({
          event: "turnstile_verification_failed",
          errorCodes: outcome["error-codes"],
        });
        throw new BadRequestException({
          code: ErrorCode.SPAM_VERIFICATION_FAILED,
          message: "Spam verification failed",
        });
      }

      return { success: true };
    } catch (err) {
      if (err instanceof BadRequestException) {
        throw err;
      }
      this.logger.error({
        event: "turnstile_siteverify_error",
        error: (err as Error).message,
      });
      // Fail closed: reject request on network/timeout errors
      throw new BadRequestException({
        code: ErrorCode.SPAM_VERIFICATION_FAILED,
        message: "Spam verification service unavailable",
      });
    }
  }
}
