import { type CallHandler, type ExecutionContext } from "@nestjs/common";
import { of } from "rxjs";
import {
  SYSTEM_TENANT_ID,
  TenantContextService,
} from "../../../../common/request-context/tenant-context.service";
import { TenantContextInterceptor } from "./tenant-context.interceptor";

describe("TenantContextInterceptor", () => {
  let interceptor: TenantContextInterceptor;
  let tenantContext: TenantContextService;

  beforeEach(() => {
    tenantContext = new TenantContextService();
    interceptor = new TenantContextInterceptor(tenantContext);
  });

  const createMockContext = (user?: any): ExecutionContext => {
    return {
      switchToHttp: () => ({
        getRequest: () => ({ user }),
      }),
    } as unknown as ExecutionContext;
  };

  const mockCallHandler: CallHandler = {
    handle: () => of({ success: true }),
  };

  it("should set isPlatform=true when schoolId is SYSTEM_TENANT_ID AND scope is 'platform'", (done) => {
    const ctx = createMockContext({
      userId: "user-123",
      schoolId: SYSTEM_TENANT_ID,
      scope: "platform",
    });

    interceptor
      .intercept(ctx, {
        handle: () => {
          expect(tenantContext.isPlatformScope()).toBe(true);
          expect(tenantContext.getTenantId()).toBe(SYSTEM_TENANT_ID);
          return of(true);
        },
      })
      .subscribe({
        complete: () => done(),
        error: done,
      });
  });

  it("should set isPlatform=false when schoolId is SYSTEM_TENANT_ID but scope is 'platform_2fa_pending'", (done) => {
    const ctx = createMockContext({
      userId: "user-123",
      schoolId: SYSTEM_TENANT_ID,
      scope: "platform_2fa_pending",
    });

    interceptor
      .intercept(ctx, {
        handle: () => {
          expect(tenantContext.isPlatformScope()).toBe(false);
          expect(tenantContext.getTenantId()).toBe(SYSTEM_TENANT_ID);
          return of(true);
        },
      })
      .subscribe({
        complete: () => done(),
        error: done,
      });
  });

  it("should set isPlatform=false when schoolId is SYSTEM_TENANT_ID but scope is 'platform_2fa_setup_pending'", (done) => {
    const ctx = createMockContext({
      userId: "user-123",
      schoolId: SYSTEM_TENANT_ID,
      scope: "platform_2fa_setup_pending",
    });

    interceptor
      .intercept(ctx, {
        handle: () => {
          expect(tenantContext.isPlatformScope()).toBe(false);
          expect(tenantContext.getTenantId()).toBe(SYSTEM_TENANT_ID);
          return of(true);
        },
      })
      .subscribe({
        complete: () => done(),
        error: done,
      });
  });

  it("should set isPlatform=false when scope is 'platform' but schoolId is a normal tenant school", (done) => {
    const tenantSchoolId = "018f6f5a-8b3a-7a8e-b7d1-0123456789ab";
    const ctx = createMockContext({
      userId: "user-123",
      schoolId: tenantSchoolId,
      scope: "platform",
    });

    interceptor
      .intercept(ctx, {
        handle: () => {
          expect(tenantContext.isPlatformScope()).toBe(false);
          expect(tenantContext.getTenantId()).toBe(tenantSchoolId);
          return of(true);
        },
      })
      .subscribe({
        complete: () => done(),
        error: done,
      });
  });
});
