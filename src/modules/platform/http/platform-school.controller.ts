import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Req,
  UseGuards,
} from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from "@nestjs/swagger";
import type { FastifyRequest } from "fastify";
import { RequirePermission } from "../../../common/decorators/require-permission.decorator";
import { PoliciesGuard } from "../../../common/guards/policies.guard";
import { ZodValidationPipe } from "../../../common/pipes/zod-validation.pipe";
import { JwtAuthGuard } from "../../identity/http/guards/jwt-auth.guard";
import { PlatformSchoolService } from "../application/platform-school.service";
import { type CreateSchoolDto, CreateSchoolSchema } from "../dto/platform-school.dto";
import { PlatformGuard } from "../guards/platform.guard";

interface AuthenticatedPlatformRequest extends FastifyRequest {
  user: {
    userId: string;
    schoolId: string;
    sessionId: string;
    scope: string;
  };
}

@ApiTags("Platform School Provisioning")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PlatformGuard, PoliciesGuard)
@Controller("platform/schools")
export class PlatformSchoolController {
  constructor(private readonly platformSchoolService: PlatformSchoolService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @RequirePermission("create", "platform.school")
  @ApiOperation({
    summary: "Provision a new tenant school with SECURITY DEFINER and built-in roles",
  })
  @ApiResponse({ status: 201, description: "School provisioned successfully" })
  @ApiResponse({ status: 400, description: "Validation error or reserved slug" })
  @ApiResponse({ status: 403, description: "Forbidden: platform administrative scope required" })
  @ApiResponse({ status: 409, description: "Conflict: school slug already exists" })
  async provisionSchool(
    @Body(new ZodValidationPipe(CreateSchoolSchema)) dto: CreateSchoolDto,
    @Req() req: AuthenticatedPlatformRequest,
  ) {
    const clientIp = req.ip || "127.0.0.1";
    const userAgent = req.headers["user-agent"];
    return this.platformSchoolService.provisionSchool(dto, req.user.userId, {
      ip: clientIp,
      userAgent,
    });
  }

  @Post(":id/reseed-roles")
  @HttpCode(HttpStatus.OK)
  @RequirePermission("update", "platform.school")
  @ApiOperation({ summary: "Reseed/repair 12 built-in roles for a tenant school" })
  @ApiResponse({ status: 200, description: "Roles reseeded successfully" })
  @ApiResponse({ status: 403, description: "Forbidden: platform administrative scope required" })
  @ApiResponse({ status: 404, description: "School not found" })
  async reseedRoles(@Param("id") id: string, @Req() req: AuthenticatedPlatformRequest) {
    const clientIp = req.ip || "127.0.0.1";
    const userAgent = req.headers["user-agent"];
    return this.platformSchoolService.reseedRoles(id, req.user.userId, {
      ip: clientIp,
      userAgent,
    });
  }
}
