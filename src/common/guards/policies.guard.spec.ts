import { type ExecutionContext, ForbiddenException, UnauthorizedException } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { RoleService } from "../../modules/identity/application/role.service";
import { AbilityFactory } from "../../modules/identity/domain/ability.factory";
import { IS_AUTHENTICATED_KEY } from "../decorators/authenticated.decorator";
import { IS_PUBLIC_KEY } from "../decorators/public.decorator";
import { REQUIRED_PERMISSIONS_KEY } from "../decorators/require-permission.decorator";
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
    reflector.getAllAndOverride.mockImplementation((key: any) => {
      if (key === IS_PUBLIC_KEY) return true;
      return undefined;
    });

    const context = createMockContext({});
    const allowed = await guard.canActivate(context);

    expect(allowed).toBe(true);
    expect(roleService.getEffectivePermissions).not.toHaveBeenCalled();
  });

  it("should allow request if marked @Authenticated and user context is present", async () => {
    reflector.getAllAndOverride.mockImplementation((key: any) => {
      if (key === IS_AUTHENTICATED_KEY) return true;
      return undefined;
    });

    const context = createMockContext({
      user: { userId: "user-1", schoolId: "school-1", sessionId: "sess-1" },
    });
    const allowed = await guard.canActivate(context);

    expect(allowed).toBe(true);
    expect(roleService.getEffectivePermissions).not.toHaveBeenCalled();
  });

  it("should throw UnauthorizedException if marked @Authenticated and user context is missing", async () => {
    reflector.getAllAndOverride.mockImplementation((key: any) => {
      if (key === IS_AUTHENTICATED_KEY) return true;
      return undefined;
    });

    const context = createMockContext({});
    await expect(guard.canActivate(context)).rejects.toThrow(UnauthorizedException);
  });

  it("should allow request if no permission requirements exist", async () => {
    reflector.getAllAndOverride.mockImplementation(() => undefined);

    const context = createMockContext({});
    const allowed = await guard.canActivate(context);

    expect(allowed).toBe(true);
  });

  it("should throw UnauthorizedException if user context is missing on protected route", async () => {
    reflector.getAllAndOverride.mockImplementation((key: any) => {
      if (key === REQUIRED_PERMISSIONS_KEY) {
        return [{ action: "read", resource: "identity.role", code: "identity.role.read" }];
      }
      return undefined;
    });

    const context = createMockContext({});
    await expect(guard.canActivate(context)).rejects.toThrow(UnauthorizedException);
  });

  it("should allow request when user holds required permission", async () => {
    reflector.getAllAndOverride.mockImplementation((key: any) => {
      if (key === REQUIRED_PERMISSIONS_KEY) {
        return [{ action: "read", resource: "identity.role", code: "identity.role.read" }];
      }
      return undefined;
    });

    roleService.getEffectivePermissions.mockResolvedValue(["identity.role.read"]);

    const context = createMockContext({
      user: { userId: "user-1", schoolId: "school-1", sessionId: "sess-1" },
    });

    const allowed = await guard.canActivate(context);
    expect(allowed).toBe(true);
    expect(roleService.getEffectivePermissions).toHaveBeenCalledWith("school-1", "user-1");
  });

  it("should throw ForbiddenException when user lacks required permission", async () => {
    reflector.getAllAndOverride.mockImplementation((key: any) => {
      if (key === REQUIRED_PERMISSIONS_KEY) {
        return [{ action: "delete", resource: "identity.role", code: "identity.role.delete" }];
      }
      return undefined;
    });

    roleService.getEffectivePermissions.mockResolvedValue(["identity.role.read"]);

    const context = createMockContext({
      user: { userId: "user-1", schoolId: "school-1", sessionId: "sess-1" },
    });

    await expect(guard.canActivate(context)).rejects.toThrow(ForbiddenException);
  });
});
