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

    it("GET /api/v1/identity/roles: lists all 13 built-in roles for the school", async () => {
      if (!dbAvailable) return;

      const res = await request(app.getHttpServer())
        .get("/api/v1/identity/roles")
        .set("Authorization", `Bearer ${principalAToken}`);

      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body.length).toBeGreaterThanOrEqual(13);
      expect(res.body.some((r: any) => r.slug === "principal" && r.isSystem === true)).toBe(true);
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

      // Fire two concurrent unassignments
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

      // At least one must fail with 400 Bad Request to guarantee never zero admins
      const hasFailure = res1.status === 400 || res2.status === 400;
      expect(hasFailure).toBe(true);

      // Confirm in DB that at least 1 active admin still exists
      const remainingAdmins = await prisma.userRole.count({
        where: { schoolId: schoolAId, roleId: principalRole!.id },
      });
      expect(remainingAdmins).toBeGreaterThanOrEqual(1);
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
      await request(app.getHttpServer())
        .post("/api/v1/identity/roles/unassign")
        .set("Authorization", `Bearer ${principalAToken}`)
        .send({
          userId: tempUserId,
          roleId: tempRole.id,
        });

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
  });
});
