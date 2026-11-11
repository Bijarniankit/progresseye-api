import { ExecutionContext, ForbiddenException, UnauthorizedException } from "@nestjs/common";
import { SYSTEM_TENANT_ID } from "../../../common/request-context/tenant-context.service";
import { PlatformGuard } from "./platform.guard";

describe("PlatformGuard", () => {
  let guard: PlatformGuard;

  beforeEach(() => {
    guard = new PlatformGuard();
  });

  const createMockContext = (user?: any): ExecutionContext => {
    return {
      switchToHttp: () => ({
        getRequest: () => ({ user }),
      }),
    } as unknown as ExecutionContext;
  };

  it("should throw UnauthorizedException if request has no user", () => {
    const ctx = createMockContext(undefined);
    expect(() => guard.canActivate(ctx)).toThrow(UnauthorizedException);
  });

  it("should throw ForbiddenException if user has non-platform schoolId", () => {
    const ctx = createMockContext({
      userId: "11111111-1111-1111-1111-111111111111",
      schoolId: "22222222-2222-2222-2222-222222222222",
      scope: "platform",
    });
    expect(() => guard.canActivate(ctx)).toThrow(ForbiddenException);
  });

  it("should throw ForbiddenException if user is in system tenant but scope is not platform", () => {
    const ctx = createMockContext({
      userId: "11111111-1111-1111-1111-111111111111",
      schoolId: SYSTEM_TENANT_ID,
      scope: "access",
    });
    expect(() => guard.canActivate(ctx)).toThrow(ForbiddenException);
  });

  it("should allow request if user is in system tenant and scope is platform", () => {
    const ctx = createMockContext({
      userId: "11111111-1111-1111-1111-111111111111",
      schoolId: SYSTEM_TENANT_ID,
      scope: "platform",
    });
    expect(guard.canActivate(ctx)).toBe(true);
  });
});
