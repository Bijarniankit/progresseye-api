import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Put,
  Req,
  UseGuards,
} from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from "@nestjs/swagger";
import type { FastifyRequest } from "fastify";
import { Authenticated } from "../../../common/decorators/authenticated.decorator";
import { RequirePermission } from "../../../common/decorators/require-permission.decorator";
import { PoliciesGuard } from "../../../common/guards/policies.guard";
import { ZodValidationPipe } from "../../../common/pipes/zod-validation.pipe";
import { RoleService } from "../application/role.service";
import {
  type AssignRoleDto,
  assignRoleSchema,
  type CloneRoleDto,
  type CreateRoleDto,
  cloneRoleSchema,
  createRoleSchema,
  type UpdateRoleDto,
  updateRoleSchema,
} from "../dto/role.dto";
import { JwtAuthGuard } from "./guards/jwt-auth.guard";

interface AuthenticatedRequest extends FastifyRequest {
  user: {
    userId: string;
    schoolId: string;
    sessionId: string;
  };
}

@ApiTags("Identity & Roles")
@ApiBearerAuth()
@Controller("identity")
@UseGuards(JwtAuthGuard, PoliciesGuard)
export class RoleController {
  constructor(private readonly roleService: RoleService) {}

  @Get("permissions")
  @RequirePermission("read", "identity.role")
  @ApiOperation({ summary: "List all global system permissions" })
  @ApiResponse({ status: 200, description: "Permissions catalog" })
  async listPermissions() {
    return this.roleService.listPermissions();
  }

  @Get("roles")
  @RequirePermission("read", "identity.role")
  @ApiOperation({ summary: "List all roles for the current school tenant" })
  @ApiResponse({ status: 200, description: "List of roles" })
  async getRoles(@Req() req: AuthenticatedRequest) {
    return this.roleService.getRoles(req.user.schoolId);
  }

  @Get("roles/:id")
  @RequirePermission("read", "identity.role")
  @ApiOperation({ summary: "Get role details with assigned permissions" })
  @ApiResponse({ status: 200, description: "Role details" })
  async getRole(@Req() req: AuthenticatedRequest, @Param("id") id: string) {
    return this.roleService.getRole(req.user.schoolId, id);
  }

  @Post("roles")
  @HttpCode(HttpStatus.CREATED)
  @RequirePermission("create", "identity.role")
  @ApiOperation({ summary: "Create a custom role with anti-escalation validation" })
  @ApiResponse({ status: 201, description: "Role created" })
  async createRole(
    @Req() req: AuthenticatedRequest,
    @Body(new ZodValidationPipe(createRoleSchema)) dto: CreateRoleDto,
  ) {
    return this.roleService.createRole(req.user.schoolId, req.user.userId, dto);
  }

  @Post("roles/:id/clone")
  @HttpCode(HttpStatus.CREATED)
  @RequirePermission("create", "identity.role")
  @ApiOperation({ summary: "Clone an existing role into a custom role" })
  @ApiResponse({ status: 201, description: "Role cloned" })
  async cloneRole(
    @Req() req: AuthenticatedRequest,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(cloneRoleSchema)) dto: CloneRoleDto,
  ) {
    return this.roleService.cloneRole(req.user.schoolId, req.user.userId, id, dto);
  }

  @Put("roles/:id")
  @HttpCode(HttpStatus.OK)
  @RequirePermission("update", "identity.role")
  @ApiOperation({ summary: "Update a custom role" })
  @ApiResponse({ status: 200, description: "Role updated" })
  async updateRole(
    @Req() req: AuthenticatedRequest,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(updateRoleSchema)) dto: UpdateRoleDto,
  ) {
    return this.roleService.updateRole(req.user.schoolId, req.user.userId, id, dto);
  }

  @Delete("roles/:id")
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermission("delete", "identity.role")
  @ApiOperation({ summary: "Delete a custom role" })
  @ApiResponse({ status: 204, description: "Role deleted" })
  async deleteRole(@Req() req: AuthenticatedRequest, @Param("id") id: string) {
    await this.roleService.deleteRole(req.user.schoolId, req.user.userId, id);
  }

  @Post("roles/assign")
  @HttpCode(HttpStatus.OK)
  @RequirePermission("assign", "identity.role")
  @ApiOperation({ summary: "Assign a role to a user" })
  @ApiResponse({ status: 200, description: "Role assigned" })
  async assignRole(
    @Req() req: AuthenticatedRequest,
    @Body(new ZodValidationPipe(assignRoleSchema)) dto: AssignRoleDto,
  ) {
    return this.roleService.assignRole(req.user.schoolId, req.user.userId, dto);
  }

  @Post("roles/unassign")
  @HttpCode(HttpStatus.OK)
  @RequirePermission("assign", "identity.role")
  @ApiOperation({ summary: "Unassign a role from a user" })
  @ApiResponse({ status: 200, description: "Role unassigned" })
  async unassignRole(
    @Req() req: AuthenticatedRequest,
    @Body(new ZodValidationPipe(assignRoleSchema)) dto: AssignRoleDto,
  ) {
    return this.roleService.unassignRole(req.user.schoolId, req.user.userId, dto);
  }

  @Post("users/:id/deactivate")
  @HttpCode(HttpStatus.OK)
  @RequirePermission("update", "identity.user")
  @ApiOperation({ summary: "Deactivate a user with last-admin lockout protection" })
  @ApiResponse({ status: 200, description: "User deactivated" })
  async deactivateUser(@Req() req: AuthenticatedRequest, @Param("id") id: string) {
    return this.roleService.deactivateUser(req.user.schoolId, req.user.userId, id);
  }

  @Get("users/me/effective-permissions")
  @Authenticated("Returns effective permissions and role slugs for current authenticated user")
  @ApiOperation({ summary: "Get effective permissions and roles for current authenticated user" })
  @ApiResponse({ status: 200, description: "Effective permissions and role slugs" })
  async getEffectivePermissionsForMe(@Req() req: AuthenticatedRequest) {
    return this.roleService.getEffectivePermissionsForMe(req.user.schoolId, req.user.userId);
  }
}
