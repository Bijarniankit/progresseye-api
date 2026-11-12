import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import type { Prisma } from "@prisma/client";
import { PrismaService } from "../../../infra/prisma/prisma.service";
import { PermissionCacheService } from "../domain/permission-cache.service";
import {
  BUILT_IN_ROLES,
  isPlatformPermission,
  PERMISSIONS_CATALOG,
  SYSTEM_PLATFORM_ROLES,
  TENANT_BUILT_IN_ROLES,
} from "../domain/permissions.catalog";
import type { AssignRoleDto, CloneRoleDto, CreateRoleDto, UpdateRoleDto } from "../dto/role.dto";

const ADMIN_REQUIRED_PERMISSIONS = ["identity.role.assign", "tenancy.school.update"];

@Injectable()
export class RoleService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: PermissionCacheService,
  ) {}

  /**
   * Seeds all permissions from the canonical catalog into the global permissions catalog.
   */
  async seedGlobalPermissions(): Promise<number> {
    let count = 0;
    for (const item of PERMISSIONS_CATALOG) {
      await this.prisma.permission.upsert({
        where: { code: item.code },
        update: {
          module: item.module,
          description: item.description,
        },
        create: {
          code: item.code,
          module: item.module,
          description: item.description,
        },
      });
      count++;
    }
    return count;
  }

  /**
   * Idempotently seeds the 13 built-in system roles and their permission mappings for a school tenant.
   * Runs strictly under the school's tenant RLS context.
   */
  async seedBuiltInRolesForSchool(schoolId: string, actorUserId?: string): Promise<void> {
    await this.seedGlobalPermissions();

    const runSeed = async (tx: Prisma.TransactionClient) => {
      // Fetch all permission records from the global catalog
      const allPermissions = await tx.permission.findMany();
      const permMap = new Map(
        allPermissions.map((p: { code: string; id: string }) => [p.code, p.id]),
      );

      const rolesToSeed =
        schoolId === "00000000-0000-0000-0000-000000000001"
          ? SYSTEM_PLATFORM_ROLES
          : TENANT_BUILT_IN_ROLES;

      for (const builtIn of rolesToSeed) {
        // Upsert Role under school_id
        let role = await tx.role.findFirst({
          where: {
            schoolId,
            slug: builtIn.slug,
          },
        });

        if (!role) {
          role = await tx.role.create({
            data: {
              schoolId,
              name: builtIn.name,
              slug: builtIn.slug,
              description: builtIn.description,
              isSystem: true,
            },
          });
        } else {
          role = await tx.role.update({
            where: { id: role.id },
            data: {
              name: builtIn.name,
              description: builtIn.description,
              isSystem: true,
            },
          });
        }

        // Bind permissions to role
        for (const code of builtIn.permissions) {
          const permId = permMap.get(code);
          if (permId) {
            await tx.rolePermission.upsert({
              where: {
                schoolId_roleId_permissionId: {
                  schoolId,
                  roleId: role.id,
                  permissionId: permId,
                },
              },
              update: {},
              create: {
                schoolId,
                roleId: role.id,
                permissionId: permId,
              },
            });
          }
        }
      }
    };

    if (actorUserId) {
      await this.prisma.withPlatformTenant(schoolId, runSeed);
    } else {
      await this.prisma.withTenant(schoolId, runSeed);
    }
  }

  /**
   * Retrieves effective permissions for a user within a school tenant.
   * Leverages Redis permission cache with fallback to PostgreSQL.
   */
  async getEffectivePermissions(schoolId: string, userId: string): Promise<string[]> {
    const cached = await this.cache.get(schoolId, userId);
    if (cached) {
      return cached;
    }

    const permissions = await this.prisma.withTenant(schoolId, async (tx) => {
      const user = await tx.user.findFirst({
        where: { id: userId, schoolId, isActive: true, deletedAt: null },
        include: {
          userRoles: {
            include: {
              role: {
                include: {
                  rolePermissions: {
                    include: {
                      permission: true,
                    },
                  },
                },
              },
            },
          },
        },
      });

      if (!user) return [];

      const permSet = new Set<string>();
      for (const ur of user.userRoles) {
        if (ur.role && !ur.role.deletedAt) {
          for (const rp of ur.role.rolePermissions) {
            if (rp.permission?.code) {
              permSet.add(rp.permission.code);
            }
          }
        }
      }

      return Array.from(permSet);
    });

    await this.cache.set(schoolId, userId, permissions);
    return permissions;
  }

  /**
   * Returns effective permissions and role slugs for the current authenticated user (for UI sidebar).
   */
  async getEffectivePermissionsForMe(
    schoolId: string,
    userId: string,
  ): Promise<{ permissions: string[]; roles: string[] }> {
    const permissions = await this.getEffectivePermissions(schoolId, userId);

    const roles = await this.prisma.withTenant(schoolId, async (tx) => {
      const userRoles = await tx.userRole.findMany({
        where: { schoolId, userId },
        include: { role: true },
      });
      return userRoles.filter((ur) => ur.role && !ur.role.deletedAt).map((ur) => ur.role.slug);
    });

    return { permissions, roles };
  }

  /**
   * Lists all available system permissions in the global catalog.
   */
  async listPermissions(): Promise<
    Array<{ code: string; module: string; description: string | null }>
  > {
    return this.prisma.permission.findMany({
      orderBy: [{ module: "asc" }, { code: "asc" }],
    });
  }

  /**
   * Lists all roles in a school tenant.
   */
  async getRoles(schoolId: string) {
    return this.prisma.withTenant(schoolId, async (tx) => {
      const roles = await tx.role.findMany({
        where: { schoolId, deletedAt: null },
        include: {
          _count: {
            select: {
              rolePermissions: true,
              userRoles: true,
            },
          },
        },
        orderBy: [{ isSystem: "desc" }, { name: "asc" }],
      });

      return roles.map((r) => ({
        id: r.id,
        name: r.name,
        slug: r.slug,
        description: r.description,
        isSystem: r.isSystem,
        permissionsCount: r._count.rolePermissions,
        usersCount: r._count.userRoles,
        createdAt: r.createdAt,
      }));
    });
  }

  /**
   * Retrieves full details for a single role including its assigned permissions.
   */
  async getRole(schoolId: string, roleId: string) {
    return this.prisma.withTenant(schoolId, async (tx) => {
      const role = await tx.role.findFirst({
        where: { id: roleId, schoolId, deletedAt: null },
        include: {
          rolePermissions: {
            include: {
              permission: true,
            },
          },
        },
      });

      if (!role) {
        throw new NotFoundException("Role not found");
      }

      return {
        id: role.id,
        name: role.name,
        slug: role.slug,
        description: role.description,
        isSystem: role.isSystem,
        permissions: role.rolePermissions.map((rp) => rp.permission.code),
        createdAt: role.createdAt,
        updatedAt: role.updatedAt,
      };
    });
  }

  /**
   * Creates a custom role with strict anti-escalation enforcement.
   */
  async createRole(schoolId: string, actorUserId: string, dto: CreateRoleDto) {
    // 1. Check for platform permissions
    if (dto.permissionCodes.some(isPlatformPermission)) {
      throw new ForbiddenException(
        "Platform permissions (platform.*) cannot be assigned to tenant roles",
      );
    }

    // 2. Anti-escalation check: actor must hold all permissions being granted
    const actorPerms = new Set(await this.getEffectivePermissions(schoolId, actorUserId));
    for (const code of dto.permissionCodes) {
      if (!actorPerms.has(code)) {
        throw new ForbiddenException(
          `Privilege escalation prevented: you do not possess permission '${code}'`,
        );
      }
    }

    return this.prisma.withTenant(schoolId, async (tx) => {
      // Check slug uniqueness within school
      const existing = await tx.role.findFirst({
        where: { schoolId, slug: dto.slug, deletedAt: null },
      });
      if (existing) {
        throw new BadRequestException(`A role with slug '${dto.slug}' already exists`);
      }

      // Verify all requested permission codes exist in global catalog
      const permissions = await tx.permission.findMany({
        where: { code: { in: dto.permissionCodes } },
      });
      if (permissions.length !== dto.permissionCodes.length) {
        throw new BadRequestException("One or more permission codes are invalid");
      }

      const role = await tx.role.create({
        data: {
          schoolId,
          name: dto.name,
          slug: dto.slug,
          description: dto.description,
          isSystem: false,
        },
      });

      // Insert role permissions
      for (const p of permissions) {
        await tx.rolePermission.create({
          data: {
            schoolId,
            roleId: role.id,
            permissionId: p.id,
          },
        });
      }

      // Record audit log
      await tx.auditLog.create({
        data: {
          schoolId,
          userId: actorUserId,
          action: "ROLE_CREATE",
          resource: "roles",
          resourceId: role.id,
          payload: {
            name: role.name,
            slug: role.slug,
            permissions: dto.permissionCodes,
          },
        },
      });

      return {
        id: role.id,
        name: role.name,
        slug: role.slug,
        description: role.description,
        isSystem: role.isSystem,
        permissions: dto.permissionCodes,
      };
    });
  }

  /**
   * Clones an existing role into a new custom role with anti-escalation enforcement.
   */
  async cloneRole(schoolId: string, actorUserId: string, sourceRoleId: string, dto: CloneRoleDto) {
    const sourceRole = await this.getRole(schoolId, sourceRoleId);

    // Anti-escalation check: actor must hold all permissions present in the source role
    const actorPerms = new Set(await this.getEffectivePermissions(schoolId, actorUserId));
    for (const code of sourceRole.permissions) {
      if (!actorPerms.has(code)) {
        throw new ForbiddenException(
          `Privilege escalation prevented: cannot clone role containing permission '${code}' which you do not possess`,
        );
      }
    }

    return this.createRole(schoolId, actorUserId, {
      name: dto.name,
      slug: dto.slug,
      description: dto.description || `Cloned from ${sourceRole.name}`,
      permissionCodes: sourceRole.permissions,
    });
  }

  /**
   * Updates a custom role, with anti-escalation and self-role edit protection.
   */
  async updateRole(schoolId: string, actorUserId: string, roleId: string, dto: UpdateRoleDto) {
    const role = await this.getRole(schoolId, roleId);
    if (role.isSystem) {
      throw new ForbiddenException("Built-in system roles cannot be modified");
    }

    // Self-role edit protection: actor cannot edit their own assigned role
    const actorRoles = await this.prisma.withTenant(schoolId, async (tx) => {
      const ur = await tx.userRole.findMany({
        where: { schoolId, userId: actorUserId },
        select: { roleId: true },
      });
      return ur.map((r) => r.roleId);
    });

    if (actorRoles.includes(roleId)) {
      throw new ForbiddenException(
        "Privilege escalation prevented: you cannot modify your own assigned role",
      );
    }

    if (dto.permissionCodes) {
      if (dto.permissionCodes.some(isPlatformPermission)) {
        throw new ForbiddenException(
          "Platform permissions (platform.*) cannot be assigned to tenant roles",
        );
      }

      // Anti-escalation check
      const actorPerms = new Set(await this.getEffectivePermissions(schoolId, actorUserId));
      for (const code of dto.permissionCodes) {
        if (!actorPerms.has(code)) {
          throw new ForbiddenException(
            `Privilege escalation prevented: you do not possess permission '${code}'`,
          );
        }
      }
    }

    return this.prisma.withTenant(schoolId, async (tx) => {
      // Row lock active users to prevent race with last-admin removal
      await tx.$queryRaw`SELECT id FROM users WHERE school_id = ${schoolId}::uuid AND is_active = true FOR UPDATE`;

      // Last-admin guard if permissions are changing
      if (dto.permissionCodes) {
        const grantsAdmin = ADMIN_REQUIRED_PERMISSIONS.every((p) => role.permissions.includes(p));
        const willGrantAdmin = ADMIN_REQUIRED_PERMISSIONS.every((p) =>
          dto.permissionCodes!.includes(p),
        );

        if (grantsAdmin && !willGrantAdmin) {
          const remainingAdmins = await this.countOtherActiveAdmins(tx, schoolId, roleId);
          if (remainingAdmins <= 0) {
            throw new BadRequestException(
              "Cannot modify role: this would leave the school with zero active administrators (CANNOT_REMOVE_LAST_ADMIN)",
            );
          }
        }
      }

      await tx.role.update({
        where: { id: roleId },
        data: {
          name: dto.name,
          description: dto.description,
        },
      });

      if (dto.permissionCodes) {
        const permissions = await tx.permission.findMany({
          where: { code: { in: dto.permissionCodes } },
        });

        // Delete existing and insert new
        await tx.rolePermission.deleteMany({
          where: { schoolId, roleId },
        });

        for (const p of permissions) {
          await tx.rolePermission.create({
            data: {
              schoolId,
              roleId,
              permissionId: p.id,
            },
          });
        }
      }

      // Find all users assigned to this role and evict their permission cache
      const assignedUsers = await tx.userRole.findMany({
        where: { schoolId, roleId },
        select: { userId: true },
      });
      const userIds = assignedUsers.map((u) => u.userId);
      await this.cache.evictUsers(schoolId, userIds);

      // Audit log
      await tx.auditLog.create({
        data: {
          schoolId,
          userId: actorUserId,
          action: "ROLE_UPDATE",
          resource: "roles",
          resourceId: roleId,
          payload: {
            name: dto.name,
            permissions: dto.permissionCodes,
          },
        },
      });

      const updated = await tx.role.findFirst({
        where: { id: roleId, schoolId, deletedAt: null },
        include: {
          rolePermissions: {
            include: { permission: true },
          },
        },
      });

      return {
        id: updated!.id,
        name: updated!.name,
        slug: updated!.slug,
        description: updated!.description,
        isSystem: updated!.isSystem,
        permissions: updated!.rolePermissions.map((rp) => rp.permission.code),
        createdAt: updated!.createdAt,
        updatedAt: updated!.updatedAt,
      };
    });
  }

  /**
   * Deletes a custom role, preventing deletion of system roles or roles currently in use.
   */
  async deleteRole(schoolId: string, actorUserId: string, roleId: string): Promise<void> {
    const role = await this.getRole(schoolId, roleId);
    if (role.isSystem) {
      throw new ForbiddenException("Built-in system roles cannot be deleted");
    }

    await this.prisma.withTenant(schoolId, async (tx) => {
      // Row lock active users
      await tx.$queryRaw`SELECT id FROM users WHERE school_id = ${schoolId}::uuid AND is_active = true FOR UPDATE`;

      // Check last-admin guard if role has admin permissions
      const grantsAdmin =
        role.slug === "principal" ||
        ADMIN_REQUIRED_PERMISSIONS.every((p) => role.permissions.includes(p));
      if (grantsAdmin) {
        const remainingAdmins = await this.countOtherActiveAdmins(tx, schoolId, roleId);
        if (remainingAdmins <= 0) {
          throw new BadRequestException(
            "Cannot delete role: this would leave the school with zero active administrators (CANNOT_REMOVE_LAST_ADMIN)",
          );
        }
      }

      const assignedUsers = await tx.userRole.findMany({
        where: { schoolId, roleId },
        select: { userId: true },
      });
      const userIds = assignedUsers.map((u) => u.userId);

      await tx.rolePermission.deleteMany({
        where: { schoolId, roleId },
      });

      await tx.userRole.deleteMany({
        where: { schoolId, roleId },
      });

      await tx.role.delete({
        where: { id: roleId },
      });

      if (userIds.length > 0) {
        await this.cache.evictUsers(schoolId, userIds);
      }

      // Audit log
      await tx.auditLog.create({
        data: {
          schoolId,
          userId: actorUserId,
          action: "ROLE_DELETE",
          resource: "roles",
          resourceId: roleId,
          payload: { name: role.name, slug: role.slug },
        },
      });
    });
  }

  /**
   * Assigns a role to a user with anti-escalation and self-assignment prohibition.
   */
  async assignRole(schoolId: string, actorUserId: string, dto: AssignRoleDto) {
    if (actorUserId === dto.userId) {
      throw new ForbiddenException(
        "Privilege escalation prevented: you cannot assign roles to yourself (CANNOT_SELF_ASSIGN_ROLE)",
      );
    }

    const role = await this.getRole(schoolId, dto.roleId);

    // Anti-escalation check: actor must possess all permissions of the role being assigned
    const actorPerms = new Set(await this.getEffectivePermissions(schoolId, actorUserId));
    for (const code of role.permissions) {
      if (!actorPerms.has(code)) {
        throw new ForbiddenException(
          `Privilege escalation prevented: cannot assign role containing permission '${code}' which you do not possess`,
        );
      }
    }

    return this.prisma.withTenant(schoolId, async (tx) => {
      const user = await tx.user.findFirst({
        where: { id: dto.userId, schoolId, deletedAt: null },
      });
      if (!user) {
        throw new NotFoundException("Target user not found in this school");
      }

      const userRole = await tx.userRole.upsert({
        where: {
          schoolId_userId_roleId: {
            schoolId,
            userId: dto.userId,
            roleId: dto.roleId,
          },
        },
        update: {},
        create: {
          schoolId,
          userId: dto.userId,
          roleId: dto.roleId,
        },
      });

      // Evict target user cache immediately
      await this.cache.evictUser(schoolId, dto.userId);

      // Audit log
      await tx.auditLog.create({
        data: {
          schoolId,
          userId: actorUserId,
          action: "ROLE_ASSIGN",
          resource: "user_roles",
          resourceId: userRole.id,
          payload: {
            targetUserId: dto.userId,
            roleId: dto.roleId,
            roleName: role.name,
          },
        },
      });

      return { success: true };
    });
  }

  /**
   * Unassigns a role from a user with last-admin lockout protection and row locking.
   */
  async unassignRole(schoolId: string, actorUserId: string, dto: AssignRoleDto) {
    const role = await this.getRole(schoolId, dto.roleId);

    return this.prisma.withTenant(schoolId, async (tx) => {
      // Row lock active users to prevent race condition leaving 0 admins
      await tx.$queryRaw`SELECT id FROM users WHERE school_id = ${schoolId}::uuid AND is_active = true FOR UPDATE`;

      const grantsAdmin =
        role.slug === "principal" ||
        ADMIN_REQUIRED_PERMISSIONS.every((p) => role.permissions.includes(p));

      if (grantsAdmin) {
        // Count active admins if this role assignment is removed
        const activeAdmins = await this.getActiveAdminUserIds(tx, schoolId);
        // If target user is an admin and the ONLY admin, refuse!
        if (activeAdmins.includes(dto.userId) && activeAdmins.length <= 1) {
          throw new BadRequestException(
            "Cannot unassign role: this user is the last active administrator of the school (CANNOT_REMOVE_LAST_ADMIN)",
          );
        }
      }

      await tx.userRole.deleteMany({
        where: {
          schoolId,
          userId: dto.userId,
          roleId: dto.roleId,
        },
      });

      // Evict target user cache immediately
      await this.cache.evictUser(schoolId, dto.userId);

      // Audit log
      await tx.auditLog.create({
        data: {
          schoolId,
          userId: actorUserId,
          action: "ROLE_UNASSIGN",
          resource: "user_roles",
          resourceId: `${dto.userId}:${dto.roleId}`,
          payload: {
            targetUserId: dto.userId,
            roleId: dto.roleId,
            roleName: role.name,
          },
        },
      });

      return { success: true };
    });
  }

  /**
   * Deactivates a user with last-admin lockout protection and row locking.
   */
  async deactivateUser(schoolId: string, actorUserId: string, targetUserId: string) {
    return this.prisma.withTenant(schoolId, async (tx) => {
      // Row lock active users to prevent race condition leaving 0 admins
      await tx.$queryRaw`SELECT id FROM users WHERE school_id = ${schoolId}::uuid AND is_active = true FOR UPDATE`;

      const user = await tx.user.findFirst({
        where: { id: targetUserId, schoolId, deletedAt: null },
      });
      if (!user) {
        throw new NotFoundException("Target user not found in this school");
      }

      if (!user.isActive) {
        return { success: true, message: "User is already inactive" };
      }

      const activeAdmins = await this.getActiveAdminUserIds(tx, schoolId);
      if (activeAdmins.includes(targetUserId) && activeAdmins.length <= 1) {
        throw new BadRequestException(
          "Cannot deactivate user: this user is the last active administrator of the school (CANNOT_REMOVE_LAST_ADMIN)",
        );
      }

      await tx.user.update({
        where: { id: targetUserId },
        data: { isActive: false },
      });

      // Evict target user cache immediately
      await this.cache.evictUser(schoolId, targetUserId);

      // Audit log
      await tx.auditLog.create({
        data: {
          schoolId,
          userId: actorUserId,
          action: "USER_DEACTIVATE",
          resource: "users",
          resourceId: targetUserId,
          payload: { targetUserId },
        },
      });

      return { success: true };
    });
  }

  /**
   * Helper: Counts active admins excluding a specific role being modified/deleted.
   */
  private async countOtherActiveAdmins(
    tx: any,
    schoolId: string,
    excludedRoleId: string,
  ): Promise<number> {
    const adminRoles = await tx.role.findMany({
      where: {
        schoolId,
        id: { not: excludedRoleId },
        deletedAt: null,
      },
      include: {
        rolePermissions: {
          include: { permission: true },
        },
      },
    });

    const validAdminRoleIds = adminRoles
      .filter(
        (r: any) =>
          r.slug === "principal" ||
          ADMIN_REQUIRED_PERMISSIONS.every((p) =>
            r.rolePermissions.some((rp: any) => rp.permission?.code === p),
          ),
      )
      .map((r: any) => r.id);

    if (!validAdminRoleIds.length) return 0;

    const activeAdminUsers = await tx.userRole.findMany({
      where: {
        schoolId,
        roleId: { in: validAdminRoleIds },
        user: { isActive: true, deletedAt: null },
      },
      select: { userId: true },
      distinct: ["userId"],
    });

    return activeAdminUsers.length;
  }

  /**
   * Helper: Returns list of user IDs who currently hold admin status.
   */
  private async getActiveAdminUserIds(tx: any, schoolId: string): Promise<string[]> {
    const adminRoles = await tx.role.findMany({
      where: { schoolId, deletedAt: null },
      include: {
        rolePermissions: {
          include: { permission: true },
        },
      },
    });

    const validAdminRoleIds = adminRoles
      .filter(
        (r: any) =>
          r.slug === "principal" ||
          ADMIN_REQUIRED_PERMISSIONS.every((p) =>
            r.rolePermissions.some((rp: any) => rp.permission?.code === p),
          ),
      )
      .map((r: any) => r.id);

    if (!validAdminRoleIds.length) return [];

    const activeAdminUsers = await tx.userRole.findMany({
      where: {
        schoolId,
        roleId: { in: validAdminRoleIds },
        user: { isActive: true, deletedAt: null },
      },
      select: { userId: true },
      distinct: ["userId"],
    });

    return activeAdminUsers.map((u: any) => u.userId);
  }
}
