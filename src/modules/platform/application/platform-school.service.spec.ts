import { BadRequestException, ConflictException, NotFoundException } from "@nestjs/common";
import { Test, TestingModule } from "@nestjs/testing";
import { AppConfigService } from "../../../config/config.service";
import { PrismaService } from "../../../infra/prisma/prisma.service";
import { RoleService } from "../../identity/application/role.service";
import { PlatformAuditService } from "./platform-audit.service";
import { PlatformSchoolService } from "./platform-school.service";

describe("PlatformSchoolService", () => {
  let service: PlatformSchoolService;
  let mockPrisma: any;
  let mockRoleService: any;
  let mockPlatformAudit: any;
  let mockConfig: any;

  beforeEach(async () => {
    mockPrisma = {
      $executeRaw: jest.fn().mockResolvedValue(1),
      $queryRaw: jest.fn(),
      school: {
        findUnique: jest.fn(),
      },
    };
    mockRoleService = {
      seedBuiltInRolesForSchool: jest.fn().mockResolvedValue(undefined),
    };
    mockPlatformAudit = {
      recordEvent: jest.fn().mockResolvedValue(undefined),
    };
    mockConfig = {
      get: jest.fn().mockReturnValue("test-hmac-secret-32-chars-long"),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PlatformSchoolService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: RoleService, useValue: mockRoleService },
        { provide: PlatformAuditService, useValue: mockPlatformAudit },
        { provide: AppConfigService, useValue: mockConfig },
      ],
    }).compile();

    service = module.get<PlatformSchoolService>(PlatformSchoolService);
  });

  describe("provisionSchool()", () => {
    it("should provision a school via platform_provision_school and seed roles", async () => {
      const generatedSchoolId = "new-school-uuid";
      mockPrisma.$queryRaw.mockResolvedValue([{ school_id: generatedSchoolId }]);

      const res = await service.provisionSchool(
        { name: "Greenwood Academy", slug: "greenwood-academy" },
        "platform-admin-uuid",
        { ip: "127.0.0.1" },
      );

      expect(res.id).toBe(generatedSchoolId);
      expect(res.name).toBe("Greenwood Academy");
      expect(res.slug).toBe("greenwood-academy");
      expect(mockRoleService.seedBuiltInRolesForSchool).toHaveBeenCalledWith(
        generatedSchoolId,
        "platform-admin-uuid",
      );
      expect(mockPlatformAudit.recordEvent).toHaveBeenCalledWith(
        expect.objectContaining({ action: "PLATFORM_SCHOOL_PROVISION_COMPLETE" }),
      );
    });

    it("should map SLUG_ALREADY_EXISTS to ConflictException", async () => {
      mockPrisma.$queryRaw.mockRejectedValue(
        new Error("SLUG_ALREADY_EXISTS: school with slug already exists"),
      );

      await expect(
        service.provisionSchool(
          { name: "Duplicate", slug: "duplicate-slug" },
          "platform-admin-uuid",
          { ip: "127.0.0.1" },
        ),
      ).rejects.toThrow(ConflictException);
    });

    it("should map RESERVED_SLUG to BadRequestException", async () => {
      mockPrisma.$queryRaw.mockRejectedValue(
        new Error("RESERVED_SLUG: system is a reserved system slug"),
      );

      await expect(
        service.provisionSchool({ name: "System Admin", slug: "system" }, "platform-admin-uuid", {
          ip: "127.0.0.1",
        }),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe("reseedRoles()", () => {
    it("should reject reseed if school does not exist", async () => {
      mockPrisma.school.findUnique.mockResolvedValue(null);

      await expect(
        service.reseedRoles("nonexistent-id", "platform-admin-uuid", { ip: "127.0.0.1" }),
      ).rejects.toThrow(NotFoundException);
    });

    it("should reseed roles for existing school and write audit row", async () => {
      mockPrisma.school.findUnique.mockResolvedValue({
        id: "school-uuid",
        slug: "existing-school",
      });

      const res = await service.reseedRoles("school-uuid", "platform-admin-uuid", {
        ip: "127.0.0.1",
      });

      expect(res.success).toBe(true);
      expect(res.reseededRoles).toBe(12);
      expect(mockRoleService.seedBuiltInRolesForSchool).toHaveBeenCalledWith(
        "school-uuid",
        "platform-admin-uuid",
      );
      expect(mockPlatformAudit.recordEvent).toHaveBeenCalledWith(
        expect.objectContaining({ action: "PLATFORM_SCHOOL_RESEED_ROLES" }),
      );
    });
  });
});
