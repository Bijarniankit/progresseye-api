import { type ExecutionContext, ForbiddenException, UnauthorizedException } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { RoleService } from "../../modules/identity/application/role.service";
import { AbilityFactory } from "../../modules/identity/domain/ability.factory";
import { PoliciesGuard } from "./policies.guard";

describe("PoliciesGuard", () => {
  let guard: PoliciesGuard;
  let reflector: jest.Mocked<Reflector>;
  let roleService: jest.Mocked<RoleService>;
  let abilityFactory: AbilityFactory;

  beforeEach(() => {
    reflector = {
      getAllAndOverride: jest.fn(),
    } as unknown as jest.Mocked<Reflector>;

    roleService = {
      getEffectivePermissions: jest.fn(),
    } as unknown as jest.Mocked<RoleService>;

    abilityFactory = new AbilityFactory();

    guard = new PoliciesGuard(reflector, roleService, abilityFactory);
  });

  const createMockContext = (request: any): ExecutionContext =>
    ({
      switchToHttp: () => ({
        getRequest: () => request,
      }),
      getHandler: () => ({}),
      getClass: () => ({}),
    }) as unknown as ExecutionContext;

  it("should allow request immediately if route is marked @Public", async () => {
    reflector.getAllAndOverride.mockReturnValueOnce(true); // isPublic

    const context = createMockContext({});
    const allowed = await guard.canActivate(context);

    expect(allowed).toBe(true);
    expect(roleService.getEffectivePermissions).not.toHaveBeenCalled();
  });

  it("should allow request if no permission requirements exist", async () => {
    reflector.getAllAndOverride
      .mockReturnValueOnce(false) // isPublic
      .mockReturnValueOnce(null); // requirements

    const context = createMockContext({});
    const allowed = await guard.canActivate(context);

    expect(allowed).toBe(true);
  });

  it("should throw UnauthorizedException if user context is missing on protected route", async () => {
    reflector.getAllAndOverride
      .mockReturnValueOnce(false)
      .mockReturnValueOnce([
        { action: "read", resource: "identity.role", code: "identity.role.read" },
      ]);

    const context = createMockContext({});
    await expect(guard.canActivate(context)).rejects.toThrow(UnauthorizedException);
  });

  it("should allow request when user holds required permission", async () => {
    reflector.getAllAndOverride
      .mockReturnValueOnce(false)
      .mockReturnValueOnce([
        { action: "read", resource: "identity.role", code: "identity.role.read" },
      ]);

    roleService.getEffectivePermissions.mockResolvedValue(["identity.role.read"]);

    const context = createMockContext({
      user: { userId: "user-1", schoolId: "school-1", sessionId: "sess-1" },
    });

    const allowed = await guard.canActivate(context);
    expect(allowed).toBe(true);
    expect(roleService.getEffectivePermissions).toHaveBeenCalledWith("school-1", "user-1");
  });

  it("should throw ForbiddenException when user lacks required permission", async () => {
    reflector.getAllAndOverride
      .mockReturnValueOnce(false)
      .mockReturnValueOnce([
        { action: "delete", resource: "identity.role", code: "identity.role.delete" },
      ]);

    roleService.getEffectivePermissions.mockResolvedValue(["identity.role.read"]);

    const context = createMockContext({
      user: { userId: "user-1", schoolId: "school-1", sessionId: "sess-1" },
    });

    await expect(guard.canActivate(context)).rejects.toThrow(ForbiddenException);
  });
});
