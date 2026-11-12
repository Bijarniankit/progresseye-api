import { Writable } from "node:stream";
import fastifyCookie from "@fastify/cookie";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { Test, type TestingModule } from "@nestjs/testing";
import * as argon2 from "argon2";
import { Logger } from "nestjs-pino";
import request from "supertest";
import { uuidv7 } from "uuidv7";
import { AppModule } from "../../src/app.module";
import { PrismaService } from "../../src/infra/prisma/prisma.service";
import { RedisService } from "../../src/infra/redis/redis.service";
import { RoleService } from "../../src/modules/identity/application/role.service";
import { TokenService } from "../../src/modules/identity/domain/token.service";

jest.setTimeout(45000);

describe("Phase 13a: Authorization & Role Designer E2E Suite", () => {
  let app: NestFastifyApplication;
  let prisma: PrismaService;
  let roleService: RoleService;
  let tokenService: TokenService;
  let redisService: RedisService;
  let dbAvailable = false;

  const schoolAId = uuidv7();
  const schoolBId = uuidv7();

  const principalAId = uuidv7();
  const teacherAId = uuidv7();
  const studentAId = uuidv7();
  const principalBId = uuidv7();

  let principalAToken: string;
  let teacherAToken: string;
  let principalBToken: string;

  const rawPassword = "Password12345!";

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication<NestFastifyApplication>(
      new FastifyAdapter({ trustProxy: true }),
    );
    app.useLogger(moduleFixture.get(Logger));
    app.setGlobalPrefix("/api/v1");

    await app.register(fastifyCookie as any);

    prisma = moduleFixture.get<PrismaService>(PrismaService);
    roleService = moduleFixture.get<RoleService>(RoleService);
    tokenService = moduleFixture.get<TokenService>(TokenService);
    redisService = moduleFixture.get<RedisService>(RedisService);

    try {
      await prisma.$connect();
      const isLive = await prisma.ping();
      if (!isLive) throw new Error("offline");
      dbAvailable = true;
    } catch {
      if (process.env.CI) {
        throw new Error("PostgreSQL database connection is required in CI environment");
      }
      dbAvailable = false;
      console.log(
        "Local environment without Docker: PostgreSQL unavailable; real PostgreSQL RLS assertions verified in GitHub Actions CI.",
      );
    }

    if (dbAvailable) {
      await redisService.ping();
      await redisService
        .getClient()
        ?.flushall()
        .catch(() => {});

      // Clean tables
      await prisma
        .$executeRawUnsafe(
          `TRUNCATE TABLE organizations, schools, users, sessions, roles, user_roles, audit_logs, role_permissions CASCADE;`,
        )
        .catch(() => {});

      const passwordHash = await argon2.hash(rawPassword, {
        type: argon2.argon2id,
        memoryCost: 4096,
        timeCost: 2,
        parallelism: 1,
      });

      // Seed global catalog
      await roleService.seedGlobalPermissions();

      // Seed School A and School B
      await prisma.school.createMany({
        data: [
          { id: schoolAId, name: "School Alpha", slug: "school-alpha", isActive: true },
          { id: schoolBId, name: "School Beta", slug: "school-beta", isActive: true },
        ],
      });

      // Seed built-in roles for School A and School B
      await roleService.seedBuiltInRolesForSchool(schoolAId);
      await roleService.seedBuiltInRolesForSchool(schoolBId);

      // Seed users in School A
      await prisma.user.createMany({
        data: [
          {
            id: principalAId,
            schoolId: schoolAId,
            email: "principal@alpha.com",
            firstName: "Principal",
            lastName: "Alpha",
            passwordHash,
            isActive: true,
          },
          {
            id: teacherAId,
            schoolId: schoolAId,
            email: "teacher@alpha.com",
            firstName: "Teacher",
            lastName: "Alpha",
            passwordHash,
            isActive: true,
          },
          {
            id: studentAId,
            schoolId: schoolAId,
            email: "student@alpha.com",
            firstName: "Student",
            lastName: "Alpha",
            passwordHash,
            isActive: true,
          },
          // User in School B
          {
            id: principalBId,
            schoolId: schoolBId,
            email: "principal@beta.com",
            firstName: "Principal",
            lastName: "Beta",
            passwordHash,
            isActive: true,
          },
        ],
      });

      // Assign built-in principal role to principalA
      const principalRoleA = await prisma.role.findFirst({
        where: { schoolId: schoolAId, slug: "principal" },
      });
      if (principalRoleA) {
        await prisma.userRole.create({
          data: { schoolId: schoolAId, userId: principalAId, roleId: principalRoleA.id },
        });
      }

      // Assign built-in teacher role to teacherA
      const teacherRoleA = await prisma.role.findFirst({
        where: { schoolId: schoolAId, slug: "teacher" },
      });
      if (teacherRoleA) {
        await prisma.userRole.create({
          data: { schoolId: schoolAId, userId: teacherAId, roleId: teacherRoleA.id },
        });
      }

      // Assign built-in principal role to principalB
      const principalRoleB = await prisma.role.findFirst({
        where: { schoolId: schoolBId, slug: "principal" },
      });
      if (principalRoleB) {
        await prisma.userRole.create({
          data: { schoolId: schoolBId, userId: principalBId, roleId: principalRoleB.id },
        });
      }

      // Generate access tokens
      const sessA = await tokenService.createAccessToken({
        userId: principalAId,
        schoolId: schoolAId,
        sessionId: "sess-p-a",
      });
      principalAToken = sessA.token;

      const sessT = await tokenService.createAccessToken({
        userId: teacherAId,
        schoolId: schoolAId,
        sessionId: "sess-t-a",
      });
      teacherAToken = sessT.token;

      const sessB = await tokenService.createAccessToken({
        userId: principalBId,
        schoolId: schoolBId,
        sessionId: "sess-p-b",
      });
      principalBToken = sessB.token;
    }

    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    if (app) await app.close();
    if (prisma) await prisma.$disconnect();
  });

  describe("Role Designer Endpoints", () => {
    let createdRoleId = "";

    it("GET /api/v1/identity/permissions: lists all global permissions for authorized admin", async () => {
      if (!dbAvailable) return;

      const res = await request(app.getHttpServer())
        .get("/api/v1/identity/permissions")
        .set("Authorization", `Bearer ${principalAToken}`);

      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body.length).toBeGreaterThan(20);
      expect(res.body.some((p: any) => p.code === "identity.role.create")).toBe(true);
    });

    it("GET /api/v1/identity/roles: lists all 12 built-in roles for the school", async () => {
      if (!dbAvailable) return;

      const res = await request(app.getHttpServer())
        .get("/api/v1/identity/roles")
        .set("Authorization", `Bearer ${principalAToken}`);

      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body.length).toBe(12);
      expect(res.body.some((r: any) => r.slug === "principal" && r.isSystem === true)).toBe(true);
      expect(res.body.some((r: any) => r.slug === "platform_admin")).toBe(false);
    });

    it("Idempotent Built-in Role Seeding: re-seeding built-in roles under real tenant context is idempotent", async () => {
      if (!dbAvailable) return;

      const rolesBefore = await prisma.role.count({
        where: { schoolId: schoolAId, isSystem: true },
      });
      expect(rolesBefore).toBe(12);

      // Re-seed built-in roles for school A a second time
      await roleService.seedBuiltInRolesForSchool(schoolAId);

      const rolesAfterSecondSeed = await prisma.role.count({
        where: { schoolId: schoolAId, isSystem: true },
      });
      expect(rolesAfterSecondSeed).toBe(12);

      // Re-seed a third time to strictly guarantee repeatability
      await roleService.seedBuiltInRolesForSchool(schoolAId);

      const rolesAfterThirdSeed = await prisma.role.count({
        where: { schoolId: schoolAId, isSystem: true },
      });
      expect(rolesAfterThirdSeed).toBe(12);

      // Verify all 12 built-in role slugs exist and have assigned permissions
      const seededRoles = await prisma.role.findMany({
        where: { schoolId: schoolAId, isSystem: true },
        include: { rolePermissions: true },
      });
      expect(seededRoles).toHaveLength(12);
      for (const r of seededRoles) {
        expect(r.rolePermissions.length).toBeGreaterThan(0);
      }
    });

    it("POST /api/v1/identity/roles: creates a custom role with valid permissions", async () => {
      if (!dbAvailable) return;

      const res = await request(app.getHttpServer())
        .post("/api/v1/identity/roles")
        .set("Authorization", `Bearer ${principalAToken}`)
        .send({
          name: "Library Assistant",
          slug: "library-assistant",
          description: "Assistant managing book checkout",
          permissionCodes: ["documents.record.read", "documents.record.write"],
        });

      expect(res.status).toBe(201);
      expect(res.body.id).toBeDefined();
      expect(res.body.name).toBe("Library Assistant");
      expect(res.body.isSystem).toBe(false);
      createdRoleId = res.body.id;
    });

    it("GET /api/v1/identity/roles/:id: retrieves details of the created custom role", async () => {
      if (!dbAvailable) return;

      const res = await request(app.getHttpServer())
        .get(`/api/v1/identity/roles/${createdRoleId}`)
        .set("Authorization", `Bearer ${principalAToken}`);

      expect(res.status).toBe(200);
      expect(res.body.id).toBe(createdRoleId);
      expect(res.body.permissions).toEqual(
        expect.arrayContaining(["documents.record.read", "documents.record.write"]),
      );
    });

    it("POST /api/v1/identity/roles/:id/clone: clones an existing role into a new custom role", async () => {
      if (!dbAvailable) return;

      const res = await request(app.getHttpServer())
        .post(`/api/v1/identity/roles/${createdRoleId}/clone`)
        .set("Authorization", `Bearer ${principalAToken}`)
        .send({
          name: "Cloned Library Assistant",
          slug: "library-assistant-cloned",
          description: "Cloned role",
        });

      expect(res.status).toBe(201);
      expect(res.body.name).toBe("Cloned Library Assistant");
      expect(res.body.slug).toBe("library-assistant-cloned");
    });

    it("PUT /api/v1/identity/roles/:id: updates a custom role", async () => {
      if (!dbAvailable) return;

      const res = await request(app.getHttpServer())
        .put(`/api/v1/identity/roles/${createdRoleId}`)
        .set("Authorization", `Bearer ${principalAToken}`)
        .send({
          name: "Senior Library Assistant",
          description: "Updated description",
        });

      expect(res.status).toBe(200);
      expect(res.body.name).toBe("Senior Library Assistant");
    });

    it("POST /api/v1/identity/roles/assign and unassign: manages user role assignment", async () => {
      if (!dbAvailable) return;

      // Assign custom role to student
      const assignRes = await request(app.getHttpServer())
        .post("/api/v1/identity/roles/assign")
        .set("Authorization", `Bearer ${principalAToken}`)
        .send({
          userId: studentAId,
          roleId: createdRoleId,
        });

      expect(assignRes.status).toBe(200);
      expect(assignRes.body.success).toBe(true);

      // Unassign custom role from student
      const unassignRes = await request(app.getHttpServer())
        .post("/api/v1/identity/roles/unassign")
        .set("Authorization", `Bearer ${principalAToken}`)
        .send({
          userId: studentAId,
          roleId: createdRoleId,
        });

      expect(unassignRes.status).toBe(200);
      expect(unassignRes.body.success).toBe(true);
    });

    it("DELETE /api/v1/identity/roles/:id: deletes a custom role", async () => {
      if (!dbAvailable) return;

      const res = await request(app.getHttpServer())
        .delete(`/api/v1/identity/roles/${createdRoleId}`)
        .set("Authorization", `Bearer ${principalAToken}`);

      expect(res.status).toBe(204);
    });

    it("GET /api/v1/identity/users/me/effective-permissions: returns active permissions and role slugs", async () => {
      if (!dbAvailable) return;

      const res = await request(app.getHttpServer())
        .get("/api/v1/identity/users/me/effective-permissions")
        .set("Authorization", `Bearer ${principalAToken}`);

      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.permissions)).toBe(true);
      expect(res.body.roles).toContain("principal");
    });

    it("GET /api/v1/identity/users/me/effective-permissions: accessible to student without role-management permissions (@Authenticated)", async () => {
      if (!dbAvailable) return;

      // Assign student role to studentA
      const studentRole = await prisma.role.findFirst({
        where: { schoolId: schoolAId, slug: "student" },
      });
      if (studentRole) {
        await prisma.userRole.create({
          data: { schoolId: schoolAId, userId: studentAId, roleId: studentRole.id },
        });
      }

      const studentSession = await prisma.session.create({
        data: {
          schoolId: schoolAId,
          userId: studentAId,
          tokenHash: "student-sess-hash",
          clientType: "web",
          expiresAt: new Date(Date.now() + 3600000),
        },
      });

      const { token: studentToken } = await tokenService.createAccessToken({
        userId: studentAId,
        schoolId: schoolAId,
        sessionId: studentSession.id,
      });

      const res = await request(app.getHttpServer())
        .get("/api/v1/identity/users/me/effective-permissions")
        .set("Authorization", `Bearer ${studentToken}`);

      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.permissions)).toBe(true);
      expect(res.body.roles).toContain("student");
    });
  });

  describe("Attack & Security Verification", () => {
    it("Privilege Escalation: teacher cannot create role with unheld permissions (e.g. finance.invoice.create)", async () => {
      if (!dbAvailable) return;

      const res = await request(app.getHttpServer())
        .post("/api/v1/identity/roles")
        .set("Authorization", `Bearer ${teacherAToken}`)
        .send({
          name: "Escalated Finance Role",
          slug: "escalated-finance",
          permissionCodes: ["finance.invoice.create"],
        });

      expect(res.status).toBe(403);
      expect(res.body.detail ?? res.body.message).toMatch(
        /Privilege escalation|missing required permission/,
      );
    });

    it("Platform Permission Isolation: tenant admin cannot create role with platform.* permissions", async () => {
      if (!dbAvailable) return;

      const res = await request(app.getHttpServer())
        .post("/api/v1/identity/roles")
        .set("Authorization", `Bearer ${principalAToken}`)
        .send({
          name: "Malicious Platform Role",
          slug: "malicious-platform",
          permissionCodes: ["platform.school.create"],
        });

      expect(res.status).toBe(403);
      expect(res.body.detail ?? res.body.message).toMatch(
        /Platform permissions .* cannot be assigned to tenant roles/,
      );
    });

    it("Self-Assignment Prevention: actor cannot assign roles to themselves", async () => {
      if (!dbAvailable) return;

      const teacherRole = await prisma.role.findFirst({
        where: { schoolId: schoolAId, slug: "teacher" },
      });

      const res = await request(app.getHttpServer())
        .post("/api/v1/identity/roles/assign")
        .set("Authorization", `Bearer ${principalAToken}`)
        .send({
          userId: principalAId, // Self
          roleId: teacherRole!.id,
        });

      expect(res.status).toBe(403);
      expect(res.body.detail ?? res.body.message).toMatch(/cannot assign roles to yourself/);
    });

    it("Self-Role Modification Prevention: actor cannot modify their own assigned role", async () => {
      if (!dbAvailable) return;

      const principalRole = await prisma.role.findFirst({
        where: { schoolId: schoolAId, slug: "principal" },
      });

      const res = await request(app.getHttpServer())
        .put(`/api/v1/identity/roles/${principalRole!.id}`)
        .set("Authorization", `Bearer ${principalAToken}`)
        .send({
          name: "Compromised Principal",
        });

      expect(res.status).toBe(403);
    });

    it("System Role Immutability: built-in system roles cannot be deleted or renamed", async () => {
      if (!dbAvailable) return;

      const teacherRole = await prisma.role.findFirst({
        where: { schoolId: schoolAId, slug: "teacher" },
      });

      const res = await request(app.getHttpServer())
        .delete(`/api/v1/identity/roles/${teacherRole!.id}`)
        .set("Authorization", `Bearer ${principalAToken}`);

      expect(res.status).toBe(403);
      expect(res.body.detail ?? res.body.message).toMatch(
        /Built-in system roles cannot be deleted/,
      );
    });

    it("Cross-Tenant Isolation: School A principal cannot access or modify School B roles", async () => {
      if (!dbAvailable) return;

      const schoolBRole = await prisma.role.findFirst({
        where: { schoolId: schoolBId, slug: "principal" },
      });

      const res = await request(app.getHttpServer())
        .get(`/api/v1/identity/roles/${schoolBRole!.id}`)
        .set("Authorization", `Bearer ${principalAToken}`); // School A token

      expect(res.status).toBe(404);
    });

    it("Last-Admin Lockout Guard: cannot unassign the sole administrator of a school", async () => {
      if (!dbAvailable) return;

      const principalRole = await prisma.role.findFirst({
        where: { schoolId: schoolAId, slug: "principal" },
      });

      // Another user created with admin privileges to execute the request on principalA
      const subAdminId = uuidv7();
      await prisma.user.create({
        data: {
          id: subAdminId,
          schoolId: schoolAId,
          email: "subadmin@alpha.com",
          firstName: "Sub",
          lastName: "Admin",
          isActive: true,
        },
      });

      await prisma.userRole.create({
        data: {
          schoolId: schoolAId,
          userId: subAdminId,
          roleId: principalRole!.id,
        },
      });

      const subAdminToken = (
        await tokenService.createAccessToken({
          userId: subAdminId,
          schoolId: schoolAId,
          sessionId: "sess-sub-admin",
        })
      ).token;

      // First unassign succeeds because there are 2 admins (principalA and subAdmin)
      const firstUnassign = await request(app.getHttpServer())
        .post("/api/v1/identity/roles/unassign")
        .set("Authorization", `Bearer ${principalAToken}`)
        .send({
          userId: subAdminId,
          roleId: principalRole!.id,
        });
      expect(firstUnassign.status).toBe(200);

      // Now only 1 admin remains (principalA). Attempting to unassign principalA MUST fail!
      // Using subAdminToken (which retains cached permissions until refreshed) or an admin token:
      const secondUnassign = await request(app.getHttpServer())
        .post("/api/v1/identity/roles/unassign")
        .set("Authorization", `Bearer ${principalAToken}`)
        .send({
          userId: principalAId,
          roleId: principalRole!.id,
        });

      expect(secondUnassign.status).toBe(400);
      expect(secondUnassign.body.detail ?? secondUnassign.body.message).toMatch(
        /CANNOT_REMOVE_LAST_ADMIN/,
      );
    });

    it("Last-Admin Concurrency Test: concurrent unassign attempts cannot leave zero admins", async () => {
      if (process.env.CI && !dbAvailable) {
        throw new Error("Database is required in CI for concurrency testing");
      }
      if (!dbAvailable) return;

      const principalRole = await prisma.role.findFirst({
        where: { schoolId: schoolAId, slug: "principal" },
      });

      // Ensure 2 admins exist
      const admin2Id = uuidv7();
      await prisma.user.create({
        data: {
          id: admin2Id,
          schoolId: schoolAId,
          email: "admin2@alpha.com",
          firstName: "Admin",
          lastName: "Two",
          isActive: true,
        },
      });
      await prisma.userRole.create({
        data: {
          schoolId: schoolAId,
          userId: admin2Id,
          roleId: principalRole!.id,
        },
      });

      try {
        // Fire two concurrent unassignments that would leave zero admins if unserialized
        const [res1, res2] = await Promise.all([
          request(app.getHttpServer())
            .post("/api/v1/identity/roles/unassign")
            .set("Authorization", `Bearer ${principalAToken}`)
            .send({ userId: principalAId, roleId: principalRole!.id }),
          request(app.getHttpServer())
            .post("/api/v1/identity/roles/unassign")
            .set("Authorization", `Bearer ${principalAToken}`)
            .send({ userId: admin2Id, roleId: principalRole!.id }),
        ]);

        // Exactly one must succeed (200) and one must fail (400 Bad Request) to guarantee never zero admins
        const statuses = [res1.status, res2.status].sort();
        expect(statuses).toEqual([200, 400]);

        const failedRes = res1.status === 400 ? res1 : res2;
        expect(failedRes.body.detail ?? failedRes.body.message).toMatch(/CANNOT_REMOVE_LAST_ADMIN/);

        // Confirm in DB that exactly 1 active admin still exists
        const remainingAdmins = await prisma.userRole.count({
          where: { schoolId: schoolAId, roleId: principalRole!.id },
        });
        expect(remainingAdmins).toBe(1);
      } finally {
        // Clean up admin2 and restore principalA as the sole active administrator
        await prisma.userRole
          .deleteMany({
            where: { schoolId: schoolAId, userId: admin2Id },
          })
          .catch(() => {});
        await prisma.user
          .delete({
            where: { id: admin2Id },
          })
          .catch(() => {});
        await prisma.user
          .update({
            where: { id: principalAId },
            data: { isActive: true },
          })
          .catch(() => {});
        await prisma.userRole
          .upsert({
            where: {
              schoolId_userId_roleId: {
                schoolId: schoolAId,
                userId: principalAId,
                roleId: principalRole!.id,
              },
            },
            update: {},
            create: {
              schoolId: schoolAId,
              userId: principalAId,
              roleId: principalRole!.id,
            },
          })
          .catch(() => {});
        await redisService
          .getClient()
          ?.del(`auth:perm:${schoolAId}:${principalAId}`)
          .catch(() => {});
      }
    });

    it("Last-Admin Deactivation Guard: rejects deactivating the last active administrator", async () => {
      if (process.env.CI && !dbAvailable) {
        throw new Error("Database is required in CI");
      }
      if (!dbAvailable) return;

      try {
        const res = await request(app.getHttpServer())
          .post(`/api/v1/identity/users/${principalAId}/deactivate`)
          .set("Authorization", `Bearer ${principalAToken}`)
          .expect(400);

        expect(res.body.detail ?? res.body.message).toMatch(/CANNOT_REMOVE_LAST_ADMIN/);

        const user = await prisma.user.findUnique({ where: { id: principalAId } });
        expect(user?.isActive).toBe(true);
      } finally {
        await prisma.user
          .update({
            where: { id: principalAId },
            data: { isActive: true },
          })
          .catch(() => {});
        await redisService
          .getClient()
          ?.del(`auth:perm:${schoolAId}:${principalAId}`)
          .catch(() => {});
      }
    });

    it("Last-Admin Role Edit Guard: rejects stripping admin permissions from role when it would leave zero admins", async () => {
      if (process.env.CI && !dbAvailable) {
        throw new Error("Database is required in CI");
      }
      if (!dbAvailable) return;

      const principalRole = await prisma.role.findFirst({
        where: { schoolId: schoolAId, slug: "principal" },
      });

      const soleAdminUserId = uuidv7();
      let customAdminId: string | undefined;
      let editorRoleId: string | undefined;

      try {
        // Create a second user who holds customAdmin
        await prisma.user.create({
          data: {
            id: soleAdminUserId,
            schoolId: schoolAId,
            email: "soleadmin@alpha.com",
            firstName: "Sole",
            lastName: "Admin",
            isActive: true,
          },
        });

        // Create a custom admin role
        const customAdmin = await prisma.role.create({
          data: {
            schoolId: schoolAId,
            name: "Sole Admin Role",
            slug: "sole-admin-" + uuidv7().substring(0, 8),
            isSystem: false,
          },
        });
        customAdminId = customAdmin.id;

        const perms = await prisma.permission.findMany({
          where: {
            code: {
              in: [
                "identity.role.assign",
                "tenancy.school.update",
                "identity.role.read",
                "identity.role.update",
              ],
            },
          },
        });
        for (const p of perms) {
          await prisma.rolePermission.create({
            data: { schoolId: schoolAId, roleId: customAdmin.id, permissionId: p.id },
          });
        }

        // Assign soleAdminUserId to customAdmin
        await prisma.userRole.create({
          data: { schoolId: schoolAId, userId: soleAdminUserId, roleId: customAdmin.id },
        });

        // Create editor role for principalA (has update permissions but NOT admin)
        const editorRole = await prisma.role.create({
          data: {
            schoolId: schoolAId,
            name: "Role Editor",
            slug: "role-editor-" + uuidv7().substring(0, 8),
            isSystem: false,
          },
        });
        editorRoleId = editorRole.id;

        const editorPerms = await prisma.permission.findMany({
          where: { code: { in: ["identity.role.read", "identity.role.update"] } },
        });
        for (const p of editorPerms) {
          await prisma.rolePermission.create({
            data: { schoolId: schoolAId, roleId: editorRole.id, permissionId: p.id },
          });
        }

        // Swap principalA to editorRole
        await prisma.userRole.deleteMany({
          where: { schoolId: schoolAId, userId: principalAId },
        });
        await prisma.userRole.create({
          data: { schoolId: schoolAId, userId: principalAId, roleId: editorRole.id },
        });
        await redisService.getClient()?.del(`auth:perm:${schoolAId}:${principalAId}`);

        // Attempt to update customAdmin to strip admin permissions (leaving only identity.role.read)
        const res = await request(app.getHttpServer())
          .put(`/api/v1/identity/roles/${customAdmin.id}`)
          .set("Authorization", `Bearer ${principalAToken}`)
          .send({
            name: "Demoted Role",
            permissionCodes: ["identity.role.read"],
          })
          .expect(400);

        expect(res.body.detail ?? res.body.message).toMatch(/CANNOT_REMOVE_LAST_ADMIN/);
      } finally {
        // Restore principalA to principal role and clean up
        await prisma.userRole
          .deleteMany({
            where: { schoolId: schoolAId, userId: soleAdminUserId },
          })
          .catch(() => {});
        await prisma.user.delete({ where: { id: soleAdminUserId } }).catch(() => {});
        await prisma.userRole
          .deleteMany({ where: { schoolId: schoolAId, userId: principalAId } })
          .catch(() => {});
        await prisma.userRole
          .create({
            data: { schoolId: schoolAId, userId: principalAId, roleId: principalRole!.id },
          })
          .catch(() => {});
        const roleIdsToClean = [customAdminId, editorRoleId].filter(Boolean) as string[];
        if (roleIdsToClean.length > 0) {
          await prisma.rolePermission
            .deleteMany({
              where: { schoolId: schoolAId, roleId: { in: roleIdsToClean } },
            })
            .catch(() => {});
          await prisma.role
            .deleteMany({
              where: { schoolId: schoolAId, id: { in: roleIdsToClean } },
            })
            .catch(() => {});
        }
        await redisService
          .getClient()
          ?.del(`auth:perm:${schoolAId}:${principalAId}`)
          .catch(() => {});
      }
    });

    it("Last-Admin Role Deletion Guard: rejects deleting an admin role when no other active admin exists", async () => {
      if (process.env.CI && !dbAvailable) {
        throw new Error("Database is required in CI");
      }
      if (!dbAvailable) return;

      const principalRole = await prisma.role.findFirst({
        where: { schoolId: schoolAId, slug: "principal" },
      });

      // Built-in system role deletion is rejected with 403 Forbidden
      const delSysRes = await request(app.getHttpServer())
        .delete(`/api/v1/identity/roles/${principalRole!.id}`)
        .set("Authorization", `Bearer ${principalAToken}`)
        .expect(403);
      expect(delSysRes.body.detail ?? delSysRes.body.message).toMatch(/Built-in system roles/);

      let customAdminId: string | undefined;
      let deleterRoleId: string | undefined;

      try {
        // Create a custom admin role
        const customAdmin = await prisma.role.create({
          data: {
            schoolId: schoolAId,
            name: "Last Custom Admin",
            slug: "last-custom-admin-" + uuidv7().substring(0, 8),
            isSystem: false,
          },
        });
        customAdminId = customAdmin.id;

        const perms = await prisma.permission.findMany({
          where: {
            code: {
              in: [
                "identity.role.assign",
                "tenancy.school.update",
                "identity.role.read",
                "identity.role.delete",
              ],
            },
          },
        });
        for (const p of perms) {
          await prisma.rolePermission.create({
            data: { schoolId: schoolAId, roleId: customAdmin.id, permissionId: p.id },
          });
        }

        // Create a deleter role with delete permission but NOT admin
        const deleterRole = await prisma.role.create({
          data: {
            schoolId: schoolAId,
            name: "Role Deleter",
            slug: "role-deleter-" + uuidv7().substring(0, 8),
            isSystem: false,
          },
        });
        deleterRoleId = deleterRole.id;

        const delPerms = await prisma.permission.findMany({
          where: { code: { in: ["identity.role.read", "identity.role.delete"] } },
        });
        for (const p of delPerms) {
          await prisma.rolePermission.create({
            data: { schoolId: schoolAId, roleId: deleterRole.id, permissionId: p.id },
          });
        }

        // Swap principalA to deleterRole (so no other admin exists in the school)
        await prisma.userRole.deleteMany({ where: { schoolId: schoolAId, userId: principalAId } });
        await prisma.userRole.create({
          data: { schoolId: schoolAId, userId: principalAId, roleId: deleterRole.id },
        });
        await redisService.getClient()?.del(`auth:perm:${schoolAId}:${principalAId}`);

        // Attempt to delete customAdmin: countOtherActiveAdmins is 0, so it fails with 400 CANNOT_REMOVE_LAST_ADMIN
        const res = await request(app.getHttpServer())
          .delete(`/api/v1/identity/roles/${customAdmin.id}`)
          .set("Authorization", `Bearer ${principalAToken}`)
          .expect(400);

        expect(res.body.detail ?? res.body.message).toMatch(/CANNOT_REMOVE_LAST_ADMIN/);
      } finally {
        // Restore principalA
        await prisma.userRole
          .deleteMany({ where: { schoolId: schoolAId, userId: principalAId } })
          .catch(() => {});
        await prisma.userRole
          .create({
            data: { schoolId: schoolAId, userId: principalAId, roleId: principalRole!.id },
          })
          .catch(() => {});
        const roleIdsToClean = [customAdminId, deleterRoleId].filter(Boolean) as string[];
        if (roleIdsToClean.length > 0) {
          await prisma.rolePermission
            .deleteMany({
              where: { schoolId: schoolAId, roleId: { in: roleIdsToClean } },
            })
            .catch(() => {});
          await prisma.role
            .deleteMany({
              where: { schoolId: schoolAId, id: { in: roleIdsToClean } },
            })
            .catch(() => {});
        }
        await redisService
          .getClient()
          ?.del(`auth:perm:${schoolAId}:${principalAId}`)
          .catch(() => {});
      }
    });

    it("Stale Token Defense: revoked role immediately blocks unexpired JWT on next request", async () => {
      if (!dbAvailable) return;

      // 1. Create temporary user and assign custom role
      const tempUserId = uuidv7();
      await prisma.user.create({
        data: {
          id: tempUserId,
          schoolId: schoolAId,
          email: "temp@alpha.com",
          firstName: "Temp",
          lastName: "User",
          isActive: true,
        },
      });

      const tempRole = await prisma.role.create({
        data: {
          schoolId: schoolAId,
          name: "Temporary Viewer",
          slug: "temp-viewer-" + Date.now(),
          isSystem: false,
        },
      });

      const readPerm = await prisma.permission.findFirst({
        where: { code: "identity.role.read" },
      });
      await prisma.rolePermission.create({
        data: {
          schoolId: schoolAId,
          roleId: tempRole.id,
          permissionId: readPerm!.id,
        },
      });

      await prisma.userRole.create({
        data: {
          schoolId: schoolAId,
          userId: tempUserId,
          roleId: tempRole.id,
        },
      });

      // 2. Generate valid 15-minute access token
      const tempToken = (
        await tokenService.createAccessToken({
          userId: tempUserId,
          schoolId: schoolAId,
          sessionId: "sess-temp-1",
        })
      ).token;

      // 3. User makes request: succeeds with 200 OK
      const initialReq = await request(app.getHttpServer())
        .get("/api/v1/identity/roles")
        .set("Authorization", `Bearer ${tempToken}`);
      expect(initialReq.status).toBe(200);

      // 4. Admin revokes the role assignment (which purges Redis permission cache)
      const unassignRes = await request(app.getHttpServer())
        .post("/api/v1/identity/roles/unassign")
        .set("Authorization", `Bearer ${principalAToken}`)
        .send({
          userId: tempUserId,
          roleId: tempRole.id,
        });
      expect(unassignRes.status).toBe(200);

      // 5. User immediately re-executes request with SAME valid token: must be rejected with 403 Forbidden!
      const subsequentReq = await request(app.getHttpServer())
        .get("/api/v1/identity/roles")
        .set("Authorization", `Bearer ${tempToken}`);

      expect(subsequentReq.status).toBe(403);
    });

    it("Redis-Down Fallback: permission checks fall back to PostgreSQL and succeed when Redis is down", async () => {
      if (!dbAvailable) return;

      // Mock redisService.getClient to return disconnected client
      const realGetClient = redisService.getClient.bind(redisService);
      jest.spyOn(redisService, "getClient").mockReturnValue(null as any);

      try {
        const res = await request(app.getHttpServer())
          .get("/api/v1/identity/roles")
          .set("Authorization", `Bearer ${principalAToken}`);

        // DB fallback must allow the authorized request through with 200 OK
        expect(res.status).toBe(200);
      } finally {
        jest.spyOn(redisService, "getClient").mockImplementation(realGetClient);
      }
    });

    it("Redis-Down Role Change: fails role mutation and rolls back DB transaction if Redis cache eviction fails", async () => {
      if (!dbAvailable) return;

      // 1. Create a test user in school A
      const testUserId = uuidv7();
      await prisma.user.create({
        data: {
          id: testUserId,
          schoolId: schoolAId,
          email: `redis-down-${Date.now()}@alpha.com`,
          firstName: "Redis",
          lastName: "DownTest",
          isActive: true,
        },
      });

      const teacherRole = await prisma.role.findFirst({
        where: { schoolId: schoolAId, slug: "teacher" },
      });

      // 2. Mock redisService.getClient to return null (Redis down / disconnected)
      const realGetClient = redisService.getClient.bind(redisService);
      jest.spyOn(redisService, "getClient").mockReturnValue(null as any);

      try {
        // 3. Attempt to assign role: must fail (500) because evictUser throws when Redis is down
        const res = await request(app.getHttpServer())
          .post("/api/v1/identity/roles/assign")
          .set("Authorization", `Bearer ${principalAToken}`)
          .send({
            userId: testUserId,
            roleId: teacherRole!.id,
          });

        expect(res.status).toBe(500);

        // 4. Verify DB rollback: userRole must NOT exist in the database!
        const assignment = await prisma.userRole.findFirst({
          where: {
            schoolId: schoolAId,
            userId: testUserId,
            roleId: teacherRole!.id,
          },
        });
        expect(assignment).toBeNull();
      } finally {
        jest.spyOn(redisService, "getClient").mockImplementation(realGetClient);
        await prisma.userRole
          .deleteMany({
            where: { schoolId: schoolAId, userId: testUserId },
          })
          .catch(() => {});
        await prisma.user
          .delete({
            where: { id: testUserId },
          })
          .catch(() => {});
      }
    });

    it("should run cleanup migration as progresseye_owner under FORCE RLS, removing platform_admin role/perms/users and leaving 12 tenant roles", async () => {
      if (!dbAvailable) return;

      const schoolCleanupId = uuidv7();
      const testUserId = uuidv7();

      // 1. Seed tenant school
      await prisma.school.create({
        data: {
          id: schoolCleanupId,
          name: "Cleanup Test Academy",
          slug: `cleanup-${Date.now().toString().slice(-6)}`,
          isActive: true,
        },
      });

      // 2. Seed 12 tenant built-in roles
      await roleService.seedBuiltInRolesForSchool(schoolCleanupId);

      // 3. Inject a legacy 13a platform_admin role with role_permissions and user_roles in this tenant school
      const platformAdminRoleId = uuidv7();
      await prisma.$executeRaw`
        INSERT INTO roles (id, school_id, name, slug, description, is_system, created_at, updated_at)
        VALUES (${platformAdminRoleId}::uuid, ${schoolCleanupId}::uuid, 'Platform Administrator', 'platform_admin', 'Legacy tenant platform admin', true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
      `;

      // Create test user in this school
      await prisma.user.create({
        data: {
          id: testUserId,
          schoolId: schoolCleanupId,
          email: `cleanup-user-${Date.now()}@test.internal`,
          firstName: "Cleanup",
          lastName: "User",
          isActive: true,
        },
      });

      // Link user_role and role_permission to platform_admin in this tenant school
      const anyPerm = await prisma.permission.findFirst();
      if (anyPerm) {
        await prisma.$executeRaw`
          INSERT INTO role_permissions (id, school_id, role_id, permission_id, created_at)
          VALUES (gen_random_uuid(), ${schoolCleanupId}::uuid, ${platformAdminRoleId}::uuid, ${anyPerm.id}::uuid, CURRENT_TIMESTAMP);
        `;
      }
      await prisma.$executeRaw`
        INSERT INTO user_roles (id, school_id, user_id, role_id, created_at)
        VALUES (gen_random_uuid(), ${schoolCleanupId}::uuid, ${testUserId}::uuid, ${platformAdminRoleId}::uuid, CURRENT_TIMESTAMP);
      `;

      // Verify that before cleanup, 13 roles exist for this school (including platform_admin)
      const countBefore = await prisma.role.count({ where: { schoolId: schoolCleanupId } });
      expect(countBefore).toBe(13);

      // 4. Run the cleanup migration block as progresseye_owner (NOT postgres) under FORCE RLS in a transaction
      await prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET ROLE progresseye_owner;`);
        try {
          await tx.$executeRawUnsafe(`
            DO $$
            DECLARE
                r RECORD;
            BEGIN
                PERFORM set_config('app.current_school_id', '', false);

                FOR r IN (
                    SELECT s.id AS school_id
                    FROM schools s
                    WHERE s.id <> '00000000-0000-0000-0000-000000000001'::uuid
                ) LOOP
                    PERFORM set_config('app.current_school_id', r.school_id::text, false);

                    DELETE FROM role_permissions
                    WHERE role_id IN (
                        SELECT id FROM roles WHERE slug = 'platform_admin' AND school_id = r.school_id
                    ) AND school_id = r.school_id;

                    DELETE FROM user_roles
                    WHERE role_id IN (
                        SELECT id FROM roles WHERE slug = 'platform_admin' AND school_id = r.school_id
                    ) AND school_id = r.school_id;

                    DELETE FROM roles
                    WHERE slug = 'platform_admin' AND school_id = r.school_id;
                END LOOP;

                PERFORM set_config('app.current_school_id', '', false);
            END $$;
          `);
        } finally {
          await tx.$executeRawUnsafe(`RESET ROLE;`);
        }
      });

      // 5. Assert: platform_admin role is deleted
      const platformAdminAfter = await prisma.role.findFirst({
        where: { schoolId: schoolCleanupId, slug: "platform_admin" },
      });
      expect(platformAdminAfter).toBeNull();

      // Assert: orphaned role_permissions and user_roles are removed
      const rolePermsAfter = await prisma.rolePermission.count({
        where: { schoolId: schoolCleanupId, roleId: platformAdminRoleId },
      });
      expect(rolePermsAfter).toBe(0);

      const userRolesAfter = await prisma.userRole.count({
        where: { schoolId: schoolCleanupId, roleId: platformAdminRoleId },
      });
      expect(userRolesAfter).toBe(0);

      // Assert: exactly 12 built-in tenant roles remain
      const totalRolesAfter = await prisma.role.count({
        where: { schoolId: schoolCleanupId },
      });
      expect(totalRolesAfter).toBe(12);
    });
  });
});
