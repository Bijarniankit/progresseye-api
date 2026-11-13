import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  UnauthorizedException,
} from "@nestjs/common";
import { ApiOperation, ApiResponse, ApiTags } from "@nestjs/swagger";
import type { FastifyRequest } from "fastify";
import { Public } from "../../../common/decorators/public.decorator";
import { ZodValidationPipe } from "../../../common/pipes/zod-validation.pipe";
import { PlatformAuthService } from "../application/platform-auth.service";
import {
  type Platform2FaEnableDto,
  Platform2FaEnableSchema,
  type Platform2FaVerifyDto,
  Platform2FaVerifySchema,
  type PlatformLoginDto,
  PlatformLoginSchema,
} from "../dto/platform-auth.dto";

function extractBearerToken(req: FastifyRequest): string {
  const authHeader = req.headers.authorization;
  if (!authHeader) {
    throw new UnauthorizedException("Authorization header is required");
  }
  const [scheme, token] = authHeader.split(" ");
  if (scheme?.toLowerCase() !== "bearer" || !token) {
    throw new UnauthorizedException("Invalid authorization scheme. Bearer token required.");
  }
  return token;
}

@ApiTags("Platform Auth")
@Controller("platform/auth")
export class PlatformAuthController {
  constructor(private readonly platformAuthService: PlatformAuthService) {}

  @Post("login")
  @Public(
    "Global platform admin authentication; verifies credentials and issues 2FA challenge token",
  )
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Platform administrator login (2FA mandatory)" })
  @ApiResponse({ status: 200, description: "2FA challenge or setup challenge issued" })
  @ApiResponse({ status: 401, description: "Invalid platform credentials" })
  async login(
    @Body(new ZodValidationPipe(PlatformLoginSchema)) dto: PlatformLoginDto,
    @Req() req: FastifyRequest,
  ) {
    const clientIp = req.ip || "127.0.0.1";
    const userAgent = req.headers["user-agent"];
    return this.platformAuthService.login(dto, { ip: clientIp, userAgent });
  }

  @Post("2fa/setup")
  @Public(
    "Platform 2FA secret generation; requires temporary platform_2fa_setup_pending scope token",
  )
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Initialize 2FA setup for platform admin" })
  @ApiResponse({ status: 200, description: "TOTP secret and provisioning URI" })
  @ApiResponse({ status: 401, description: "Unauthorized or invalid temporary token" })
  async setup2Fa(@Req() req: FastifyRequest) {
    const token = extractBearerToken(req);
    return this.platformAuthService.setup2Fa(token);
  }

  @Post("2fa/enable")
  @Public(
    "Platform 2FA enrollment completion; requires temporary platform_2fa_setup_pending scope token",
  )
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: "Verify first code to activate platform 2FA and receive recovery codes",
  })
  @ApiResponse({ status: 200, description: "2FA activated and full platform session issued" })
  @ApiResponse({ status: 400, description: "Invalid code or setup not initiated" })
  @ApiResponse({ status: 401, description: "Unauthorized" })
  async enable2Fa(
    @Body(new ZodValidationPipe(Platform2FaEnableSchema)) dto: Platform2FaEnableDto,
    @Req() req: FastifyRequest,
  ) {
    const token = extractBearerToken(req);
    const clientIp = req.ip || "127.0.0.1";
    const userAgent = req.headers["user-agent"];
    return this.platformAuthService.enable2Fa(token, dto, { ip: clientIp, userAgent });
  }

  @Post("2fa/verify")
  @Public("Platform 2FA challenge completion; requires temporary platform_2fa_pending scope token")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Complete platform login with 6-digit TOTP code or recovery code" })
  @ApiResponse({ status: 200, description: "Login successful; returns platform access token" })
  @ApiResponse({ status: 401, description: "Invalid two-factor code or credentials" })
  async verify2Fa(
    @Body(new ZodValidationPipe(Platform2FaVerifySchema)) dto: Platform2FaVerifyDto,
    @Req() req: FastifyRequest,
  ) {
    const token = extractBearerToken(req);
    const clientIp = req.ip || "127.0.0.1";
    const userAgent = req.headers["user-agent"];
    return this.platformAuthService.verify2Fa(token, dto, { ip: clientIp, userAgent });
  }
}
