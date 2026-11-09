import "@fastify/cookie";
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Req,
  Res,
  UnauthorizedException,
  UseGuards,
  UseInterceptors,
} from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from "@nestjs/swagger";
import type { FastifyReply, FastifyRequest } from "fastify";
import { ZodValidationPipe } from "../../../common/pipes/zod-validation.pipe";
import { AppConfigService } from "../../../config/config.service";
import { AuthService } from "../application/auth.service";
import { LoginResponseDto, RefreshResponseDto, SessionListDto } from "../dto/auth-response.dto";
import { ChangePasswordDto, ChangePasswordSchema } from "../dto/change-password.dto";
import { LoginDto, LoginSchema } from "../dto/login.dto";
import { PasswordStrengthDto, PasswordStrengthSchema } from "../dto/password-strength.dto";
import { RefreshDto, RefreshSchema } from "../dto/refresh.dto";
import { CurrentUser } from "./decorators/current-user.decorator";
import { type AuthenticatedUser, JwtAuthGuard } from "./guards/jwt-auth.guard";
import { TenantContextInterceptor } from "./interceptors/tenant-context.interceptor";

@ApiTags("Authentication & Sessions")
@Controller("auth")
export class AuthController {
  private readonly isProd: boolean;

  constructor(
    private readonly authService: AuthService,
    private readonly config: AppConfigService,
  ) {
    this.isProd =
      this.config.get("APP_ENV") === "production" || this.config.get("NODE_ENV") === "production";
  }

  @Post("login")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Authenticate with school slug and credentials" })
  @ApiResponse({ status: 200, type: LoginResponseDto })
  @ApiResponse({ status: 401, description: "Invalid credentials" })
  async login(
    @Body(new ZodValidationPipe(LoginSchema)) dto: LoginDto,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) res: FastifyReply,
  ): Promise<LoginResponseDto> {
    const isMobile =
      dto.clientType === "mobile" ||
      req.headers["x-client-type"] === "mobile" ||
      req.headers["X-Client-Type"] === "mobile";

    const clientIp = req.ip || "127.0.0.1";
    const userAgent = req.headers["user-agent"];

    const result = await this.authService.login(dto, {
      ip: clientIp,
      userAgent,
    });

    // Set HTTP-only refresh cookie (no Partitioned per Amendment 5)
    res.setCookie("pe_refresh_token", result.compoundRefreshToken, {
      path: "/api/v1/auth",
      httpOnly: true,
      secure: this.isProd,
      sameSite: "lax",
      maxAge: 30 * 24 * 60 * 60, // 30 days
    });

    return {
      accessToken: result.accessToken,
      expiresIn: result.expiresIn,
      user: result.user,
      refreshToken: isMobile ? result.compoundRefreshToken : undefined,
    };
  }

  @Post("refresh")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Rotate refresh token and obtain new access token" })
  @ApiResponse({ status: 200, type: RefreshResponseDto })
  @ApiResponse({ status: 401, description: "Invalid or expired token" })
  async refresh(
    @Body(new ZodValidationPipe(RefreshSchema)) dto: RefreshDto,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) res: FastifyReply,
  ): Promise<RefreshResponseDto> {
    const cookieToken = req.cookies?.pe_refresh_token;
    const compoundToken = cookieToken || dto.refreshToken;

    if (!compoundToken) {
      throw new UnauthorizedException("Refresh token is required via cookie or request body");
    }

    const isMobile =
      dto.clientType === "mobile" ||
      req.headers["x-client-type"] === "mobile" ||
      req.headers["X-Client-Type"] === "mobile";

    const origin = req.headers.origin as string | undefined;
    const referer = req.headers.referer as string | undefined;
    const clientIp = req.ip || "127.0.0.1";
    const userAgent = req.headers["user-agent"];

    const result = await this.authService.refresh(compoundToken, {
      ip: clientIp,
      userAgent,
      origin,
      referer,
    });

    res.setCookie("pe_refresh_token", result.compoundRefreshToken, {
      path: "/api/v1/auth",
      httpOnly: true,
      secure: this.isProd,
      sameSite: "lax",
      maxAge: 30 * 24 * 60 * 60,
    });

    return {
      accessToken: result.accessToken,
      expiresIn: result.expiresIn,
      refreshToken: isMobile ? result.compoundRefreshToken : undefined,
    };
  }

  @Post("logout")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Terminate current session" })
  async logout(
    @Body(new ZodValidationPipe(RefreshSchema)) dto: RefreshDto,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) res: FastifyReply,
  ): Promise<{ success: boolean; message: string }> {
    const cookieToken = req.cookies?.pe_refresh_token;
    const compoundToken = cookieToken || dto.refreshToken;
    const origin = req.headers.origin as string | undefined;
    const referer = req.headers.referer as string | undefined;

    await this.authService.logout(compoundToken, { origin, referer });

    res.clearCookie("pe_refresh_token", {
      path: "/api/v1/auth",
    });

    return {
      success: true,
      message: "Successfully logged out.",
    };
  }

  @Post("logout-all")
  @UseGuards(JwtAuthGuard)
  @UseInterceptors(TenantContextInterceptor)
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Terminate all active sessions for current user" })
  async logoutAll(
    @CurrentUser() user: AuthenticatedUser,
    @Res({ passthrough: true }) res: FastifyReply,
  ): Promise<{ success: boolean; message: string; revokedSessions: number }> {
    const { count } = await this.authService.logoutAll(user.schoolId, user.userId);

    res.clearCookie("pe_refresh_token", {
      path: "/api/v1/auth",
    });

    return {
      success: true,
      message: "All sessions have been revoked.",
      revokedSessions: count,
    };
  }

  @Get("sessions")
  @UseGuards(JwtAuthGuard)
  @UseInterceptors(TenantContextInterceptor)
  @ApiBearerAuth()
  @ApiOperation({ summary: "List active sessions for current user" })
  @ApiResponse({ status: 200, type: SessionListDto })
  async getSessions(@CurrentUser() user: AuthenticatedUser): Promise<SessionListDto> {
    const sessions = await this.authService.getSessions(user.schoolId, user.userId, user.sessionId);
    return { sessions };
  }

  @Delete("sessions/:id")
  @UseGuards(JwtAuthGuard)
  @UseInterceptors(TenantContextInterceptor)
  @ApiBearerAuth()
  @ApiOperation({ summary: "Revoke a specific active session" })
  async revokeSession(
    @Param("id") sessionId: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<{ success: boolean; message: string }> {
    await this.authService.revokeSession(user.schoolId, user.userId, sessionId);
    return {
      success: true,
      message: "Session successfully revoked.",
    };
  }

  @Post("change-password")
  @UseGuards(JwtAuthGuard)
  @UseInterceptors(TenantContextInterceptor)
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth()
  @ApiOperation({
    summary: "Change current user password and revoke all other active sessions",
  })
  async changePassword(
    @CurrentUser() user: AuthenticatedUser,
    @Body(new ZodValidationPipe(ChangePasswordSchema)) body: ChangePasswordDto,
    @Req() req: FastifyRequest,
  ) {
    const ip = req.ip || "127.0.0.1";
    const userAgent = (req.headers["user-agent"] as string) || "unknown";
    return this.authService.changePassword(user.schoolId, user.userId, user.sessionId, body, {
      ip,
      userAgent,
    });
  }

  @Get("me")
  @UseGuards(JwtAuthGuard)
  @UseInterceptors(TenantContextInterceptor)
  @ApiBearerAuth()
  @ApiOperation({ summary: "Get profile of currently authenticated user" })
  async getMe(@CurrentUser() user: AuthenticatedUser) {
    return this.authService.getMe(user.schoolId, user.userId);
  }

  @Post("password-strength")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Evaluate password strength and return feedback" })
  passwordStrength(@Body(new ZodValidationPipe(PasswordStrengthSchema)) dto: PasswordStrengthDto) {
    return this.authService.evaluatePasswordStrength(dto.password, dto.userInputs);
  }
}
