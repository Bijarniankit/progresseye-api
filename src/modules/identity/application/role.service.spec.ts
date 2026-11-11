import { BadRequestException, ForbiddenException, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../../../infra/prisma/prisma.service";
import { PermissionCacheService } from "../domain/permission-cache.service";
import { RoleService } from "./role.service";

describe("RoleService", () => {
  let service: RoleService;
  let mockPrisma: any;
  let mockCache: jest.Mocked<PermissionCacheService>;

  const schoolId = "11111111-1111-4111-8111-111111111111";
  const actorUserId = "22222222-2222-4222-8222-222222222222";
  const targetUserId = "33333333-3333-4333-8333-333333333333";

  beforeEach(() => {
    mockCache = {
      get: jest.fn(),
      set: jest.fn(),
      evictUser: jest.fn(),
      evictUsers: jest.fn(),
    } as unknown as jest.Mocked<PermissionCacheService>;

    mockPrisma = {
      permission: {
        upsert: jest.fn(),
        findMany: jest.fn().mockResolvedValue([
          { id: "p1", code: "identity.role.create", module: "identity" },
          { id: "p2", code: "identity.role.read", module: "identity" },
          { id: "p3", code: "identity.role.assign", module: "identity" },
          { id: "p4", code: "tenancy.school.update", module: "tenancy" },
        ]),
      },
      role: {
        findFirst: jest.fn(),
        findMany: jest.fn(),
        create: jest.fn(),
        update: jest.fn().mockImplementation((args: any) => ({
          id: args.where?.id || "role-updated",
          ...args.data,
        })),
        delete: jest.fn(),
      },
      rolePermission: {
        upsert: jest.fn(),
        create: jest.fn(),
        deleteMany: jest.fn(),
      },
      userRole: {
        findFirst: jest.fn(),
        findMany: jest.fn(),
        upsert: jest.fn(),
        deleteMany: jest.fn(),
        count: jest.fn(),
      },
      user: {
        findFirst: jest.fn(),
      },
      auditLog: {
        create: jest.fn(),
      },
      $executeRaw: jest.fn(),
      $queryRaw: jest.fn(),
      withTenant: jest.fn().mockImplementation(async (_sId: string, fn: any) => fn(mockPrisma)),
    };

    service = new RoleService(mockPrisma as unknown as PrismaService, mockCache);
  });

  describe("seedGlobalPermissions", () => {
    it("should upsert all permissions from the catalog", async () => {
      const count = await service.seedGlobalPermissions();
      expect(count).toBeGreaterThan(20);
      expect(mockPrisma.permission.upsert).toHaveBeenCalled();
    });
  });

  describe("seedBuiltInRolesForSchool (Idempotency)", () => {
    it("should seed 13 built-in roles under tenant context idempotently", async () => {
      mockPrisma.role.findFirst.mockResolvedValue(null);
      mockPrisma.role.create.mockImplementation((args: any) => ({
        id: "role-" + args.data.slug,
        ...args.data,
      }));

      await service.seedBuiltInRolesForSchool(schoolId);
      expect(mockPrisma.withTenant).toHaveBeenCalledWith(schoolId, expect.any(Function));

      // Test running a second time (idempotency check)
      mockPrisma.role.findFirst.mockImplementation((args: any) => ({
        id: "role-" + args.where.slug,
        schoolId,
        slug: args.where.slug,
      }));
      await service.seedBuiltInRolesForSchool(schoolId);
      expect(mockPrisma.role.update).toHaveBeenCalled();
    });
  });

  describe("getEffectivePermissions", () => {
    it("should return cached permissions when cache hit occurs", async () => {
      mockCache.get.mockResolvedValue(["identity.role.read"]);

      const perms = await service.getEffectivePermissions(schoolId, actorUserId);
      expect(perms).toEqual(["identity.role.read"]);
      expect(mockPrisma.withTenant).not.toHaveBeenCalled();
    });

    it("should query database on cache miss and store in cache", async () => {
      mockCache.get.mockResolvedValue(null);
      mockPrisma.user.findFirst.mockResolvedValue({
        id: actorUserId,
        schoolId,
        userRoles: [
          {
            role: {
              deletedAt: null,
              rolePermissions: [
                { permission: { code: "identity.role.read" } },
                { permission: { code: "identity.role.create" } },
              ],
            },
          },
        ],
      });

      const perms = await service.getEffectivePermissions(schoolId, actorUserId);
      expect(perms).toEqual(["identity.role.read", "identity.role.create"]);
      expect(mockCache.set).toHaveBeenCalledWith(schoolId, actorUserId, perms);
    });
  });

  describe("Anti-Escalation Engine", () => {
    it("should reject creating role with platform.* permissions", async () => {
      await expect(
        service.createRole(schoolId, actorUserId, {
          name: "Attacker Role",
          slug: "attacker",
          permissionCodes: ["platform.school.create"],
        }),
      ).rejects.toThrow(ForbiddenException);
    });

    it("should reject creating role with permissions the actor lacks", async () => {
      mockCache.get.mockResolvedValue(["identity.role.read"]);

      await expect(
        service.createRole(schoolId, actorUserId, {
          name: "Elevated Role",
          slug: "elevated",
          permissionCodes: ["identity.role.create", "identity.role.delete"],
        }),
      ).rejects.toThrow(ForbiddenException);
    });

    it("should reject self-assignment of roles", async () => {
      await expect(
        service.assignRole(schoolId, actorUserId, {
          userId: actorUserId,
          roleId: "any-role-id",
        }),
      ).rejects.toThrow(ForbiddenException);
    });

    it("should reject editing actor's own assigned role", async () => {
      mockPrisma.role.findFirst.mockResolvedValue({
        id: "own-role-id",
        schoolId,
        name: "Custom Teacher",
        isSystem: false,
        rolePermissions: [],
      });

      mockPrisma.userRole.findMany.mockResolvedValue([{ roleId: "own-role-id" }]);

      await expect(
        service.updateRole(schoolId, actorUserId, "own-role-id", {
          name: "Hacked Role",
        }),
      ).rejects.toThrow(ForbiddenException);
    });

    it("should reject assigning a role containing permissions the actor lacks", async () => {
      mockCache.get.mockResolvedValue(["identity.role.read"]); // Actor only has read

      mockPrisma.role.findFirst.mockResolvedValue({
        id: "target-role-id",
        schoolId,
        name: "Admin Role",
        isSystem: false,
        rolePermissions: [{ permission: { code: "identity.role.assign" } }],
      });

      await expect(
        service.assignRole(schoolId, actorUserId, {
          userId: targetUserId,
          roleId: "target-role-id",
        }),
      ).rejects.toThrow(ForbiddenException);
    });
  });

  describe("Last-Admin Lockout Guard", () => {
    it("should prevent unassigning the last active admin of the school", async () => {
      mockPrisma.role.findFirst.mockResolvedValue({
        id: "principal-role-id",
        slug: "principal",
        name: "Principal",
        isSystem: true,
        rolePermissions: [
          { permission: { code: "identity.role.assign" } },
          { permission: { code: "tenancy.school.update" } },
        ],
      });

      // Exactly 1 active admin exists in school
      mockPrisma.role.findMany.mockResolvedValue([
        {
          id: "principal-role-id",
          slug: "principal",
          rolePermissions: [
            { permission: { code: "identity.role.assign" } },
            { permission: { code: "tenancy.school.update" } },
          ],
        },
      ]);

      mockPrisma.userRole.findMany.mockResolvedValue([{ userId: targetUserId }]);

      await expect(
        service.unassignRole(schoolId, actorUserId, {
          userId: targetUserId,
          roleId: "principal-role-id",
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it("should prevent updating an admin role to strip permissions when no other admin exists", async () => {
      mockPrisma.role.findFirst.mockResolvedValue({
        id: "custom-admin-id",
        slug: "custom-admin",
        name: "Custom Admin",
        isSystem: false,
        rolePermissions: [
          { permission: { code: "identity.role.assign" } },
          { permission: { code: "tenancy.school.update" } },
        ],
      });

      mockPrisma.userRole.findMany
        .mockResolvedValueOnce([]) // Actor does not hold this role
        .mockResolvedValueOnce([]); // Other active admins query returns 0

      mockPrisma.role.findMany.mockResolvedValue([]); // No other admin roles

      // Actor has all permissions
      mockCache.get.mockResolvedValue([
        "identity.role.assign",
        "tenancy.school.update",
        "identity.role.read",
      ]);

      await expect(
        service.updateRole(schoolId, actorUserId, "custom-admin-id", {
          permissionCodes: ["identity.role.read"], // Stripping admin permissions
        }),
      ).rejects.toThrow(BadRequestException);
    });
  });
});
