import { ExecutionContext, ForbiddenException, UnauthorizedException } from "@nestjs/common";
import { SYSTEM_TENANT_ID } from "../../../common/request-context/tenant-context.service";
import { PlatformGuard } from "./platform.guard";

describe("PlatformGuard", () => {
  let guard: PlatformGuard;
  let mockPrisma: any;
  let mockRedisService: any;
  let mockRedisClient: any;

  beforeEach(() => {
    mockRedisClient = {
      status: "ready",
      get: jest.fn().mockResolvedValue(null),
      set: jest.fn().mockResolvedValue("OK"),
    };
    mockRedisService = {
      getClient: jest.fn().mockReturnValue(mockRedisClient),
    };
    mockPrisma = {
      withTenant: jest.fn().mockImplementation((_, fn) =>
        fn({
          user: {
            findFirst: jest.fn().mockResolvedValue({
              id: "admin-1",
              isActive: true,
              userRoles: [{ role: { slug: "platform_admin" } }],
              sessions: [
                { id: "session-1", revokedAt: null, expiresAt: new Date(Date.now() + 100000) },
              ],
            }),
          },
        }),
      ),
    };

    guard = new PlatformGuard(mockPrisma, mockRedisService);
  });

  const createMockContext = (user?: any): ExecutionContext => {
    return {
      switchToHttp: () => ({
        getRequest: () => ({ user }),
      }),
    } as unknown as ExecutionContext;
  };

  it("should throw UnauthorizedException if request has no user", async () => {
    const ctx = createMockContext(undefined);
    await expect(guard.canActivate(ctx)).rejects.toThrow(UnauthorizedException);
  });

  it("should throw ForbiddenException if user has non-platform schoolId", async () => {
    const ctx = createMockContext({
      userId: "11111111-1111-1111-1111-111111111111",
      schoolId: "22222222-2222-2222-2222-222222222222",
      sessionId: "session-1",
      scope: "platform",
    });
    await expect(guard.canActivate(ctx)).rejects.toThrow(ForbiddenException);
  });

  it("should throw ForbiddenException if user is in system tenant but scope is not platform", async () => {
    const ctx = createMockContext({
      userId: "11111111-1111-1111-1111-111111111111",
      schoolId: SYSTEM_TENANT_ID,
      sessionId: "session-1",
      scope: "access",
    });
    await expect(guard.canActivate(ctx)).rejects.toThrow(ForbiddenException);
  });

  it("should allow request if user is in system tenant, active, holds role, session valid", async () => {
    const ctx = createMockContext({
      userId: "11111111-1111-1111-1111-111111111111",
      schoolId: SYSTEM_TENANT_ID,
      sessionId: "session-1",
      scope: "platform",
    });
    const result = await guard.canActivate(ctx);
    expect(result).toBe(true);
    expect(mockRedisClient.set).toHaveBeenCalledWith(
      expect.stringContaining("platform:guard:"),
      "1",
      "EX",
      30,
    );
  });

  it("should reject with UnauthorizedException if platform admin is deactivated", async () => {
    mockPrisma.withTenant.mockImplementationOnce((_: any, fn: any) =>
      fn({
        user: {
          findFirst: jest.fn().mockResolvedValue({
            id: "admin-1",
            isActive: false, // Inactive admin
            userRoles: [{ role: { slug: "platform_admin" } }],
            sessions: [
              { id: "session-1", revokedAt: null, expiresAt: new Date(Date.now() + 100000) },
            ],
          }),
        },
      }),
    );

    const ctx = createMockContext({
      userId: "admin-1",
      schoolId: SYSTEM_TENANT_ID,
      sessionId: "session-1",
      scope: "platform",
    });
    await expect(guard.canActivate(ctx)).rejects.toThrow(UnauthorizedException);
  });

  it("should reject with ForbiddenException if platform_admin role was removed", async () => {
    mockPrisma.withTenant.mockImplementationOnce((_: any, fn: any) =>
      fn({
        user: {
          findFirst: jest.fn().mockResolvedValue({
            id: "admin-1",
            isActive: true,
            userRoles: [], // Role removed
            sessions: [
              { id: "session-1", revokedAt: null, expiresAt: new Date(Date.now() + 100000) },
            ],
          }),
        },
      }),
    );

    const ctx = createMockContext({
      userId: "admin-1",
      schoolId: SYSTEM_TENANT_ID,
      sessionId: "session-1",
      scope: "platform",
    });
    await expect(guard.canActivate(ctx)).rejects.toThrow(ForbiddenException);
  });

  it("should reject with UnauthorizedException if platform session was revoked", async () => {
    mockPrisma.withTenant.mockImplementationOnce((_: any, fn: any) =>
      fn({
        user: {
          findFirst: jest.fn().mockResolvedValue({
            id: "admin-1",
            isActive: true,
            userRoles: [{ role: { slug: "platform_admin" } }],
            sessions: [], // Session revoked / expired
          }),
        },
      }),
    );

    const ctx = createMockContext({
      userId: "admin-1",
      schoolId: SYSTEM_TENANT_ID,
      sessionId: "session-1",
      scope: "platform",
    });
    await expect(guard.canActivate(ctx)).rejects.toThrow(UnauthorizedException);
  });

  it("should bypass DB query when valid state is cached in Redis", async () => {
    mockRedisClient.get.mockResolvedValueOnce("1");

    const ctx = createMockContext({
      userId: "admin-1",
      schoolId: SYSTEM_TENANT_ID,
      sessionId: "session-1",
      scope: "platform",
    });
    const result = await guard.canActivate(ctx);
    expect(result).toBe(true);
    expect(mockPrisma.withTenant).not.toHaveBeenCalled();
  });
});
