import { Reflector } from "@nestjs/core";
import { AuthController } from "../../modules/identity/http/auth.controller";
import { RoleController } from "../../modules/identity/http/role.controller";
import { DiagnosticController } from "../../modules/platform/diagnostic/diagnostic.controller";
import { HealthController } from "../../modules/platform/health/health.controller";
import { PublicController } from "../../modules/public/http/public.controller";
import { IS_PUBLIC_KEY, PUBLIC_JUSTIFICATION_KEY } from "../decorators/public.decorator";
import { REQUIRED_PERMISSIONS_KEY } from "../decorators/require-permission.decorator";

describe("Route Permission Coverage (Phase 13)", () => {
  const reflector = new Reflector();

  const controllers = [
    HealthController,
    DiagnosticController,
    PublicController,
    AuthController,
    RoleController,
  ];

  it("should enforce that 100% of controller routes declare either @RequirePermission or @Public with a justification", () => {
    const unannotatedRoutes: string[] = [];

    for (const controller of controllers) {
      const proto = controller.prototype as Record<string, any>;
      const methodNames = Object.getOwnPropertyNames(proto).filter(
        (prop) => prop !== "constructor" && typeof proto[prop] === "function",
      );

      for (const methodName of methodNames) {
        const handler = proto[methodName];

        const hasRequiredPermission = reflector.get(REQUIRED_PERMISSIONS_KEY, handler);
        const isPublic = reflector.get(IS_PUBLIC_KEY, handler);
        const justification = reflector.get(PUBLIC_JUSTIFICATION_KEY, handler);

        const isCompliant =
          (hasRequiredPermission && hasRequiredPermission.length > 0) ||
          (isPublic === true &&
            typeof justification === "string" &&
            justification.trim().length > 0);

        if (!isCompliant) {
          unannotatedRoutes.push(`${controller.name}.${methodName}`);
        }
      }
    }

    if (unannotatedRoutes.length > 0) {
      throw new Error(
        `Route Coverage Failure: The following routes lack permission metadata or @Public() justification:\n` +
          unannotatedRoutes.map((r) => `  - ${r}`).join("\n"),
      );
    }

    expect(unannotatedRoutes).toHaveLength(0);
  });
});
