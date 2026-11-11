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
import { Public } from "../../../common/decorators/public.decorator";
import { ZodValidationPipe } from "../../../common/pipes/zod-validation.pipe";
import { AppConfigService } from "../../../config/config.service";
import { AuthService } from "../application/auth.service";
import { TokenService } from "../domain/token.service";
import {
  GenericMessageResponseDto,
  LoginResponseDto,
  RefreshResponseDto,
  SessionListDto,
  TwoFactorEnableResponseDto,
  TwoFactorSetupResponseDto,
} from "../dto/auth-response.dto";
import { ChangePasswordDto, ChangePasswordSchema } from "../dto/change-password.dto";
import { Disable2FaDto, Disable2FaSchema } from "../dto/disable-2fa.dto";
import { Enable2FaDto, Enable2FaSchema } from "../dto/enable-2fa.dto";
import { FirstLoginPasswordDto, FirstLoginPasswordSchema } from "../dto/first-login-password.dto";
import { ForgotPasswordDto, ForgotPasswordSchema } from "../dto/forgot-password.dto";
import { LoginDto, LoginSchema } from "../dto/login.dto";
import { PasswordStrengthDto, PasswordStrengthSchema } from "../dto/password-strength.dto";
import { RecoveryCodeVerifyDto, RecoveryCodeVerifySchema } from "../dto/recovery-code-verify.dto";
import { RefreshDto, RefreshSchema } from "../dto/refresh.dto";
import {
  RegenerateRecoveryCodesDto,
  RegenerateRecoveryCodesSchema,
} from "../dto/regenerate-recovery-codes.dto";
import { ResendVerificationDto, ResendVerificationSchema } from "../dto/resend-verification.dto";
import { ResetPasswordDto, ResetPasswordSchema } from "../dto/reset-password.dto";
import { SmsOtpDto, SmsOtpSchema } from "../dto/sms-otp.dto";
import { TotpVerifyDto, TotpVerifySchema } from "../dto/totp-verify.dto";
import { VerifyEmailDto, VerifyEmailSchema } from "../dto/verify-email.dto";
import { CurrentUser } from "./decorators/current-user.decorator";
import { type AuthenticatedUser, JwtAuthGuard } from "./guards/jwt-auth.guard";
import { TenantContextInterceptor } from "./interceptors/tenant-context.interceptor";

@ApiTags("Authentication & Sessions")
@Controller("auth")
export class AuthController {
  private readonly isProd: boolean;

  constructor(
    private readonly authService: AuthService,
    private readonly tokenService: TokenService,
    private readonly config: AppConfigService,
  ) {
    this.isProd =
      this.config.get("APP_ENV") === "production" || this.config.get("NODE_ENV") === "production";
  }

  @Post("login")
  @Public("User authentication with school slug and credentials")
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

    if (result.requires2Fa) {
      return {
        requires2Fa: true,
        temporaryToken: result.temporaryToken,
        expiresIn: result.expiresIn,
        user: result.user,
      };
    }

    if (result.mustChangePassword) {
      return {
        mustChangePassword: true,
        temporaryToken: result.temporaryToken,
        expiresIn: result.expiresIn,
        user: result.user,
      };
    }

    // Set HTTP-only refresh cookie
    res.setCookie("pe_refresh_token", result.compoundRefreshToken!, {
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
  @Public("Session token refresh via pe_refresh_token cookie or body")
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
  @Public("Session termination via refresh token or cookie")
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
  @Public("Authenticated user session termination across all devices")
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
  @Public("Authenticated user session inspection")
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
  @Public("Authenticated user single session revocation")
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
  @Public("Authenticated user password change and session invalidation")
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
  @Public("Authenticated user self profile retrieval")
  @UseGuards(JwtAuthGuard)
  @UseInterceptors(TenantContextInterceptor)
  @ApiBearerAuth()
  @ApiOperation({ summary: "Get profile of currently authenticated user" })
  async getMe(@CurrentUser() user: AuthenticatedUser) {
    return this.authService.getMe(user.schoolId, user.userId);
  }

  @Post("password-strength")
  @Public("Password entropy and strength calculation tool")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Evaluate password strength and return feedback" })
  passwordStrength(@Body(new ZodValidationPipe(PasswordStrengthSchema)) dto: PasswordStrengthDto) {
    return this.authService.evaluatePasswordStrength(dto.password, dto.userInputs);
  }

  @Post("first-login-password")
  @Public("Forced first-login password update with pwd_change_pending scope")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Forced password change upon first login" })
  @ApiResponse({ status: 200, type: LoginResponseDto })
  async firstLoginPassword(
    @Body(new ZodValidationPipe(FirstLoginPasswordSchema)) dto: FirstLoginPasswordDto,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) res: FastifyReply,
  ): Promise<LoginResponseDto> {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      throw new UnauthorizedException("Authorization header is required");
    }
    const token = authHeader.slice(7).trim();
    const claims = await this.tokenService.verifyAccessToken(token);

    const clientIp = req.ip || "127.0.0.1";
    const userAgent = req.headers["user-agent"];
    const isMobile =
      req.headers["x-client-type"] === "mobile" || req.headers["X-Client-Type"] === "mobile";

    const result = await this.authService.firstLoginPassword(
      { userId: claims.sub, schoolId: claims.schoolId, scope: claims.scope },
      dto,
      {
        ip: clientIp,
        userAgent,
        clientType: isMobile ? "mobile" : "web",
      },
    );

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
      user: result.user,
      refreshToken: isMobile ? result.compoundRefreshToken : undefined,
    };
  }

  @Post("forgot-password")
  @Public("Password reset initiation link request")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Request password reset email link" })
  @ApiResponse({ status: 200, type: GenericMessageResponseDto })
  async forgotPassword(
    @Body(new ZodValidationPipe(ForgotPasswordSchema)) dto: ForgotPasswordDto,
    @Req() req: FastifyRequest,
  ): Promise<GenericMessageResponseDto> {
    const clientIp = req.ip || "127.0.0.1";
    const userAgent = req.headers["user-agent"];
    return this.authService.forgotPassword(dto, { ip: clientIp, userAgent });
  }

  @Post("reset-password")
  @Public("Password reset completion with compound token")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Reset password using single-use compound token" })
  @ApiResponse({ status: 200, type: GenericMessageResponseDto })
  async resetPassword(
    @Body(new ZodValidationPipe(ResetPasswordSchema)) dto: ResetPasswordDto,
    @Req() req: FastifyRequest,
  ): Promise<GenericMessageResponseDto> {
    const clientIp = req.ip || "127.0.0.1";
    return this.authService.resetPassword(dto, { ip: clientIp });
  }

  @Post("verify-email")
  @Public("Email address verification with compound token")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Verify email using compound token" })
  @ApiResponse({ status: 200, type: GenericMessageResponseDto })
  async verifyEmail(
    @Body(new ZodValidationPipe(VerifyEmailSchema)) dto: VerifyEmailDto,
  ): Promise<GenericMessageResponseDto> {
    return this.authService.verifyEmail(dto);
  }

  @Post("verify-email/resend")
  @Public("Resend email verification link request")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Resend email verification link" })
  @ApiResponse({ status: 200, type: GenericMessageResponseDto })
  async resendVerification(
    @Body(new ZodValidationPipe(ResendVerificationSchema)) dto: ResendVerificationDto,
    @Req() req: FastifyRequest,
  ): Promise<GenericMessageResponseDto> {
    const clientIp = req.ip || "127.0.0.1";
    return this.authService.resendVerification(dto, { ip: clientIp });
  }

  @Post("2fa/setup")
  @Public("Authenticated user two-factor setup initialization")
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: "Initialize TOTP two-factor setup and obtain secret URI" })
  @ApiResponse({ status: 200, type: TwoFactorSetupResponseDto })
  @ApiResponse({ status: 401, description: "Unauthorized" })
  async setup2Fa(@CurrentUser() user: AuthenticatedUser): Promise<TwoFactorSetupResponseDto> {
    return this.authService.setup2Fa(user.schoolId, user.userId);
  }

  @Post("2fa/enable")
  @Public("Authenticated user two-factor enablement with first verified code")
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: "Verify first code to activate 2FA and receive recovery codes" })
  @ApiResponse({ status: 200, type: TwoFactorEnableResponseDto })
  @ApiResponse({ status: 400, description: "Invalid code or setup not initiated" })
  async enable2Fa(
    @CurrentUser() user: AuthenticatedUser,
    @Body(new ZodValidationPipe(Enable2FaSchema)) dto: Enable2FaDto,
  ): Promise<TwoFactorEnableResponseDto> {
    return this.authService.enable2Fa(user.schoolId, user.userId, dto.code);
  }

  @Post("2fa/verify")
  @Public("Two-factor authentication code challenge completion with 2fa_pending scope")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Complete login with 6-digit TOTP code and temporary token" })
  @ApiResponse({ status: 200, type: LoginResponseDto })
  @ApiResponse({ status: 401, description: "Invalid credentials" })
  @ApiResponse({ status: 503, description: "Authentication service temporarily unavailable" })
  async verify2Fa(
    @Body(new ZodValidationPipe(TotpVerifySchema)) dto: TotpVerifyDto,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) res: FastifyReply,
  ): Promise<LoginResponseDto> {
    const isMobile =
      req.headers["x-client-type"] === "mobile" || req.headers["X-Client-Type"] === "mobile";
    const clientIp = req.ip || "127.0.0.1";
    const userAgent = req.headers["user-agent"];

    const result = await this.authService.verify2Fa(dto, {
      ip: clientIp,
      userAgent,
      clientType: isMobile ? "mobile" : "web",
    });

    if (result.mustChangePassword) {
      return {
        mustChangePassword: true,
        temporaryToken: result.temporaryToken,
        expiresIn: result.expiresIn,
        user: result.user,
      };
    }

    res.setCookie("pe_refresh_token", result.compoundRefreshToken!, {
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

  @Post("2fa/recovery")
  @Public("Two-factor recovery code challenge completion with 2fa_pending scope")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Complete login using single-use recovery code and temporary token" })
  @ApiResponse({ status: 200, type: LoginResponseDto })
  @ApiResponse({ status: 401, description: "Invalid credentials" })
  async verifyRecoveryCode(
    @Body(new ZodValidationPipe(RecoveryCodeVerifySchema)) dto: RecoveryCodeVerifyDto,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) res: FastifyReply,
  ): Promise<LoginResponseDto> {
    const isMobile =
      req.headers["x-client-type"] === "mobile" || req.headers["X-Client-Type"] === "mobile";
    const clientIp = req.ip || "127.0.0.1";
    const userAgent = req.headers["user-agent"];

    const result = await this.authService.verifyRecoveryCode(dto, {
      ip: clientIp,
      userAgent,
      clientType: isMobile ? "mobile" : "web",
    });

    if (result.mustChangePassword) {
      return {
        mustChangePassword: true,
        temporaryToken: result.temporaryToken,
        expiresIn: result.expiresIn,
        user: result.user,
      };
    }

    res.setCookie("pe_refresh_token", result.compoundRefreshToken!, {
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

  @Post("2fa/disable")
  @Public("Authenticated user two-factor disablement")
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: "Disable two-factor authentication" })
  @ApiResponse({ status: 200, type: GenericMessageResponseDto })
  async disable2Fa(
    @CurrentUser() user: AuthenticatedUser,
    @Body(new ZodValidationPipe(Disable2FaSchema)) dto: Disable2FaDto,
  ): Promise<GenericMessageResponseDto> {
    return this.authService.disable2Fa(user.schoolId, user.userId, user.sessionId, dto);
  }

  @Post("2fa/recovery/regenerate")
  @Public("Authenticated user recovery codes regeneration")
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: "Regenerate single-use recovery codes and revoke older codes" })
  @ApiResponse({ status: 200, type: TwoFactorEnableResponseDto })
  async regenerateRecoveryCodes(
    @CurrentUser() user: AuthenticatedUser,
    @Body(new ZodValidationPipe(RegenerateRecoveryCodesSchema)) dto: RegenerateRecoveryCodesDto,
  ): Promise<TwoFactorEnableResponseDto> {
    return this.authService.regenerateRecoveryCodes(
      user.schoolId,
      user.userId,
      user.sessionId,
      dto,
    );
  }

  @Post("sms/send-otp")
  @Public("SMS OTP challenge request stub")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Request one-time SMS verification code (stub)" })
  @ApiResponse({ status: 200, type: GenericMessageResponseDto })
  async sendSmsOtp(
    @Body(new ZodValidationPipe(SmsOtpSchema)) dto: SmsOtpDto,
  ): Promise<GenericMessageResponseDto> {
    return this.authService.sendSmsOtp(dto);
  }
}
