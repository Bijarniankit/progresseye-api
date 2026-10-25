import crypto from "node:crypto";
import { Controller, Get, Headers, NotFoundException, Req } from "@nestjs/common";
import { ApiExcludeController } from "@nestjs/swagger";
import type { FastifyRequest } from "fastify";
import { AppConfigService } from "../../../config/config.service";

@ApiExcludeController()
@Controller("diagnostic")
export class DiagnosticController {
  constructor(private readonly config: AppConfigService) {}

  @Get("hop-trace")
  getHopTrace(@Req() req: FastifyRequest, @Headers("x-forwarded-for") xForwardedFor?: string) {
    // Explicit opt-in gate: DIAGNOSTICS_ENABLED must be true, strictly prohibited in production
    if (this.config.isProduction || !this.config.get("DIAGNOSTICS_ENABLED")) {
      throw new NotFoundException("Diagnostic endpoints are disabled");
    }

    const hops = xForwardedFor
      ? xForwardedFor
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
      : [];
    const clientReportedHops = hops.length;
    const fastifyTrustedProxyCount = this.config.get("TRUSTED_PROXY_COUNT");

    // Unified secret name: LEAD_IP_HMAC_SECRET
    const hmacSecret = this.config.get("LEAD_IP_HMAC_SECRET");
    const hashIp = (ip: string) =>
      crypto.createHmac("sha256", hmacSecret).update(ip).digest("hex").slice(0, 8);

    const socketIp = req.socket.remoteAddress || "unknown";
    const derivedIp = req.ip || "unknown";

    const socketIpHashPrefix = hashIp(socketIp);
    const derivedIpHashPrefix = hashIp(derivedIp);
    const matchesSocketIp = socketIpHashPrefix === derivedIpHashPrefix;

    return {
      status: "ok",
      diagnosticNote:
        "X-Forwarded-For header is client-controlled unless overwritten/stripped by trusted reverse proxies",
      clientReportedHops,
      fastifyTrustedProxyCount,
      socketIpHashPrefix,
      derivedIpHashPrefix,
      matchesSocketIp,
      appEnv: this.config.get("APP_ENV"),
      timestamp: new Date().toISOString(),
    };
  }
}
