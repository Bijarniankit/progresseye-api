import crypto from "node:crypto";
import { Controller, Get, Headers, NotFoundException, Req } from "@nestjs/common";
import { ApiOperation, ApiResponse, ApiTags } from "@nestjs/swagger";
import type { FastifyRequest } from "fastify";
import { AppConfigService } from "../../../config/config.service";

@ApiTags("Diagnostic")
@Controller("diagnostic")
export class DiagnosticController {
  constructor(private readonly config: AppConfigService) {}

  @Get("hop-trace")
  @ApiOperation({
    summary: "Diagnostic hop trace (staging/dev only)",
    description:
      "Returns hop count and truncated IP hash prefix for ingress calibration. Never exposes raw IP addresses.",
  })
  @ApiResponse({ status: 200, description: "Hop trace diagnostic metadata" })
  @ApiResponse({
    status: 404,
    description: "Diagnostic endpoints are disabled in production",
  })
  getHopTrace(@Req() req: FastifyRequest, @Headers("x-forwarded-for") xForwardedFor?: string) {
    if (this.config.isProduction) {
      throw new NotFoundException("Diagnostic endpoints are disabled in production");
    }

    const hops = xForwardedFor
      ? xForwardedFor
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
      : [];
    const hopCount = hops.length;

    // Never return raw IP: derive Fastify-resolved IP, hash with HMAC-SHA256, and truncate to 8-char prefix
    const rawIp = req.ip || "unknown";
    const hmacSecret = this.config.get("LEAD_IP_HMAC_SECRET") || "diagnostic-hmac-secret";
    const fullHash = crypto.createHmac("sha256", hmacSecret).update(rawIp).digest("hex");
    const ipHashPrefix = fullHash.slice(0, 8);

    return {
      status: "ok",
      hopCount,
      ipHashPrefix,
      trustedProxyConfig: this.config.get("TRUSTED_PROXY_COUNT"),
      appEnv: this.config.get("APP_ENV"),
      timestamp: new Date().toISOString(),
    };
  }
}
