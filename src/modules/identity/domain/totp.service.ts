import * as crypto from "node:crypto";
import {
  Injectable,
  InternalServerErrorException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { AppConfigService } from "../../../config/config.service";
import { RedisService } from "../../../infra/redis/redis.service";

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(buffer: Buffer): string {
  let bits = 0;
  let value = 0;
  let output = "";

  for (let i = 0; i < buffer.length; i++) {
    const byte = buffer[i] ?? 0;
    value = (value << 8) | byte;
    bits += 8;

    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }

  if (bits > 0) {
    output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  }

  return output;
}

export function base32Decode(str: string): Buffer {
  const cleaned = str.toUpperCase().replace(/[=\s-]/g, "");
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];

  for (let i = 0; i < cleaned.length; i++) {
    const char = cleaned[i] ?? "";
    const idx = BASE32_ALPHABET.indexOf(char);
    if (idx === -1) {
      throw new Error(`Invalid base32 character: ${char}`);
    }
    value = (value << 5) | idx;
    bits += 5;

    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }

  return Buffer.from(bytes);
}

export function generateHotp(secret: Buffer, counter: number | bigint): string {
  const counterBuffer = Buffer.alloc(8);
  counterBuffer.writeBigInt64BE(BigInt(counter), 0);

  const hmac = crypto.createHmac("sha1", secret).update(counterBuffer).digest();
  const offset = (hmac[hmac.length - 1] ?? 0) & 0x0f;
  const binary =
    (((hmac[offset] ?? 0) & 0x7f) << 24) |
    (((hmac[offset + 1] ?? 0) & 0xff) << 16) |
    (((hmac[offset + 2] ?? 0) & 0xff) << 8) |
    ((hmac[offset + 3] ?? 0) & 0xff);

  const otp = binary % 1_000_000;
  return otp.toString().padStart(6, "0");
}

@Injectable()
export class TotpService {
  constructor(
    private readonly config: AppConfigService,
    private readonly redisService: RedisService,
  ) {}

  /**
   * Derives 256-bit encryption key strictly from AUTH_TOTP_ENC_KEY.
   */
  private getEncryptionKey(): Buffer {
    const rawKey = this.config.get("AUTH_TOTP_ENC_KEY");
    if (!rawKey || rawKey.length < 32) {
      throw new InternalServerErrorException(
        "AUTH_TOTP_ENC_KEY must be at least 32 characters long",
      );
    }
    return crypto.createHash("sha256").update(rawKey).digest();
  }

  /**
   * Encrypts plain base32 secret using AES-256-GCM.
   */
  encryptSecret(plainBase32Secret: string): {
    encryptedSecret: string;
    iv: string;
    authTag: string;
  } {
    const key = this.getEncryptionKey();
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
    let encrypted = cipher.update(plainBase32Secret, "utf8", "hex");
    encrypted += cipher.final("hex");
    const authTag = cipher.getAuthTag().toString("hex");

    return {
      encryptedSecret: encrypted,
      iv: iv.toString("hex"),
      authTag,
    };
  }

  /**
   * Decrypts AES-256-GCM encrypted secret. Returns null if key is wrong or tag is invalid.
   */
  decryptSecret(
    encryptedSecret: string,
    ivHex: string,
    authTagHex: string,
    customKey?: Buffer,
  ): string | null {
    try {
      const key = customKey ?? this.getEncryptionKey();
      const iv = Buffer.from(ivHex, "hex");
      const authTag = Buffer.from(authTagHex, "hex");
      const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
      decipher.setAuthTag(authTag);
      let decrypted = decipher.update(encryptedSecret, "hex", "utf8");
      decrypted += decipher.final("utf8");
      return decrypted;
    } catch {
      return null;
    }
  }

  /**
   * Generates a 20-byte random secret, base32 encoded.
   */
  generateSecret(): string {
    const secretBytes = crypto.randomBytes(20);
    return base32Encode(secretBytes);
  }

  /**
   * Generates standard otpauth URI.
   */
  generateOtpAuthUri(secret: string, email: string, issuer = "ProgressEye"): string {
    const encodedIssuer = encodeURIComponent(issuer);
    const encodedEmail = encodeURIComponent(email);
    return `otpauth://totp/${encodedIssuer}:${encodedEmail}?secret=${secret}&issuer=${encodedIssuer}&algorithm=SHA1&digits=6&period=30`;
  }

  /**
   * Generates a new 20-byte random secret, base32 encoded, and its otpauth URI.
   */
  generateTotpSetup(
    email: string,
    issuer = "ProgressEye",
  ): {
    secret: string;
    uri: string;
  } {
    const secret = this.generateSecret();
    const uri = this.generateOtpAuthUri(secret, email, issuer);

    return {
      secret,
      uri,
    };
  }

  /**
   * Computes the TOTP code for a secret at a specific timestamp (default: now).
   */
  generateCode(base32Secret: string, timestampMs = Date.now()): string {
    const secretBytes = base32Decode(base32Secret);
    const timeStep = Math.floor(timestampMs / 1000 / 30);
    return generateHotp(secretBytes, timeStep);
  }

  /**
   * Verifies a 6-digit TOTP code against a base32 secret with +/- 1 step drift window (total 3 steps).
   * Returns the matched timeStep if valid, or null if no match.
   */
  verifyCodeWithoutReplay(
    base32Secret: string,
    candidateCode: string,
    timestampMs = Date.now(),
  ): number | null {
    if (!candidateCode || candidateCode.length !== 6 || !/^\d{6}$/.test(candidateCode)) {
      return null;
    }

    let secretBytes: Buffer;
    try {
      secretBytes = base32Decode(base32Secret);
    } catch {
      return null;
    }

    const currentStep = Math.floor(timestampMs / 1000 / 30);
    const candidateBuffer = Buffer.from(candidateCode);

    for (const step of [currentStep, currentStep - 1, currentStep + 1]) {
      const expectedCode = generateHotp(secretBytes, step);
      const expectedBuffer = Buffer.from(expectedCode);
      if (
        candidateBuffer.length === expectedBuffer.length &&
        crypto.timingSafeEqual(candidateBuffer, expectedBuffer)
      ) {
        return step;
      }
    }

    return null;
  }

  /**
   * Verifies TOTP code and ensures replay protection via Redis SET NX.
   * If Redis is down: throws ServiceUnavailableException (503).
   * If replayed or invalid: returns false.
   */
  async verifyTotpCode(
    userId: string,
    base32Secret: string,
    candidateCode: string,
    timestampMs = Date.now(),
  ): Promise<boolean> {
    const matchedStep = this.verifyCodeWithoutReplay(base32Secret, candidateCode, timestampMs);
    if (matchedStep === null) {
      return false;
    }

    // Check replay via Redis SET NX
    const redisClient = this.redisService.getClient();
    if (!redisClient || redisClient.status !== "ready") {
      throw new ServiceUnavailableException(
        "Authentication service temporarily unavailable. Please try again.",
      );
    }

    try {
      const replayKey = `auth:totp:replay:${userId}:${matchedStep}`;
      const setResult = await redisClient.set(replayKey, "1", "EX", 120, "NX");
      if (!setResult) {
        // Already set -> Replay detected
        return false;
      }
      return true;
    } catch (err: unknown) {
      if (err instanceof ServiceUnavailableException) {
        throw err;
      }
      throw new ServiceUnavailableException(
        "Authentication service temporarily unavailable. Please try again.",
      );
    }
  }

  /**
   * Generates 8 single-use recovery codes, formatted as 10 characters base32 (XXXXX-XXXXX).
   */
  generateRecoveryCodes(): {
    plainCodes: string[];
    hashedCodes: string[];
  } {
    const plainCodes: string[] = [];
    const hashedCodes: string[] = [];

    for (let i = 0; i < 8; i++) {
      // 10 base32 characters = 50 bits of entropy
      const rawBytes = crypto.randomBytes(7);
      const rawBase32 = base32Encode(rawBytes).substring(0, 10);
      const formatted = `${rawBase32.substring(0, 5)}-${rawBase32.substring(5, 10)}`;
      const normalized = rawBase32.toUpperCase();
      const hash = this.hashRecoveryCode(normalized);

      plainCodes.push(formatted);
      hashedCodes.push(hash);
    }

    return { plainCodes, hashedCodes };
  }

  /**
   * Computes SHA-256 hash of a normalized recovery code.
   */
  hashRecoveryCode(code: string): string {
    const normalized = code.toUpperCase().replace(/[\s-]/g, "");
    return crypto.createHash("sha256").update(normalized).digest("hex");
  }

  /**
   * Checks and increments per-user failure cap shared between TOTP and recovery codes.
   * Max 5 failed attempts per user in 15 minutes.
   */
  async checkAndIncrementAttemptCap(userId: string): Promise<boolean> {
    const redisClient = this.redisService.getClient();
    if (!redisClient || redisClient.status !== "ready") {
      throw new ServiceUnavailableException(
        "Authentication service temporarily unavailable. Please try again.",
      );
    }

    const key = `auth:2fa:attempts:${userId}`;
    const attempts = await redisClient.incr(key);
    if (attempts === 1) {
      await redisClient.expire(key, 900); // 15 minutes
    }

    return attempts <= 5;
  }

  /**
   * Resets per-user attempt cap upon successful 2FA verification.
   */
  async resetAttemptCap(userId: string): Promise<void> {
    const redisClient = this.redisService.getClient();
    if (redisClient && redisClient.status === "ready") {
      await redisClient.del(`auth:2fa:attempts:${userId}`).catch(() => {});
    }
  }
}
