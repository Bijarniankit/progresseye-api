import { METHOD_METADATA, PATH_METADATA } from "@nestjs/common/constants";
import { DiscoveryModule, DiscoveryService, MetadataScanner, Reflector } from "@nestjs/core";
import { Test, type TestingModule } from "@nestjs/testing";
import { AppModule } from "../../app.module";
import {
  AUTHENTICATED_JUSTIFICATION_KEY,
  IS_AUTHENTICATED_KEY,
} from "../decorators/authenticated.decorator";
import { IS_PUBLIC_KEY, PUBLIC_JUSTIFICATION_KEY } from "../decorators/public.decorator";
import { REQUIRED_PERMISSIONS_KEY } from "../decorators/require-permission.decorator";

describe("Route Permission Coverage (Phase 13)", () => {
  let moduleRef: TestingModule | undefined;
  let discoveryService: DiscoveryService;
  let metadataScanner: MetadataScanner;
  let reflector: Reflector;

  const originalDatabaseUrl = process.env.DATABASE_URL;

  beforeAll(async () => {
    // Provide a dummy DATABASE_URL if absent in unit test environments without .env
    process.env.DATABASE_URL =
      process.env.DATABASE_URL || "postgresql://postgres:postgres@localhost:5432/test_db";

    moduleRef = await Test.createTestingModule({
      imports: [AppModule, DiscoveryModule],
    }).compile();

    discoveryService = moduleRef.get(DiscoveryService);
    metadataScanner = moduleRef.get(MetadataScanner);
    reflector = moduleRef.get(Reflector);
  });

  afterAll(async () => {
    if (moduleRef) {
      await moduleRef.close();
    }
    if (originalDatabaseUrl !== undefined) {
      process.env.DATABASE_URL = originalDatabaseUrl;
    } else {
      delete process.env.DATABASE_URL;
    }
  });

  it("should discover all registered controllers and enforce that 100% of route handlers declare @RequirePermission, @Authenticated, or justified @Public", () => {
    const controllers = discoveryService.getControllers();
    expect(controllers.length).toBeGreaterThan(0);

    const unannotatedRoutes: string[] = [];
    let totalRoutesChecked = 0;

    for (const wrapper of controllers) {
      const { instance, metatype } = wrapper;
      if (!instance || !metatype) continue;

      const controllerName = metatype.name;
      const prototype = Object.getPrototypeOf(instance);
      const methodNames = metadataScanner.getAllMethodNames(prototype);

      for (const methodName of methodNames) {
        const handler = prototype[methodName];

        // Only inspect methods that are actual HTTP route handlers
        const hasPathMetadata = reflector.get(PATH_METADATA, handler) !== undefined;
        const hasMethodMetadata = reflector.get(METHOD_METADATA, handler) !== undefined;

        if (!hasPathMetadata && !hasMethodMetadata) {
          continue;
        }

        totalRoutesChecked++;

        const hasRequiredPermission = reflector.get(REQUIRED_PERMISSIONS_KEY, handler);
        const isPublic = reflector.get(IS_PUBLIC_KEY, handler);
        const publicJustification = reflector.get(PUBLIC_JUSTIFICATION_KEY, handler);
        const isAuthenticated = reflector.get(IS_AUTHENTICATED_KEY, handler);
        const authJustification = reflector.get(AUTHENTICATED_JUSTIFICATION_KEY, handler);

        const isCompliant =
          (hasRequiredPermission && hasRequiredPermission.length > 0) ||
          (isAuthenticated === true &&
            typeof authJustification === "string" &&
            authJustification.trim().length > 0) ||
          (isPublic === true &&
            typeof publicJustification === "string" &&
            publicJustification.trim().length > 0);

        if (!isCompliant) {
          unannotatedRoutes.push(`${controllerName}.${methodName}`);
        }
      }
    }

    if (unannotatedRoutes.length > 0) {
      throw new Error(
        `Route Coverage Failure: The following discovered routes lack @RequirePermission, @Authenticated, or @Public() justification:\n` +
          unannotatedRoutes.map((r) => `  - ${r}`).join("\n"),
      );
    }

    expect(unannotatedRoutes).toHaveLength(0);
    expect(totalRoutesChecked).toBeGreaterThan(15);
  });

  it("should match committed routes snapshot ensuring no unregistered or unvetted route modifications", () => {
    const controllers = discoveryService.getControllers();
    const discovered: string[] = [];

    for (const wrapper of controllers) {
      const { instance, metatype } = wrapper;
      if (!instance || !metatype) continue;

      const controllerPath = Reflect.getMetadata(PATH_METADATA, metatype) || "";
      const prototype = Object.getPrototypeOf(instance);
      const methodNames = metadataScanner.getAllMethodNames(prototype);

      for (const methodName of methodNames) {
        const handler = prototype[methodName];
        const methodPath = reflector.get(PATH_METADATA, handler);
        const httpCode = reflector.get(METHOD_METADATA, handler);
        if (methodPath === undefined || httpCode === undefined) continue;

        const httpMethod =
          ["GET", "POST", "PUT", "DELETE", "PATCH", "ALL", "OPTIONS", "HEAD"][httpCode] ||
          "UNKNOWN";
        const cleanBasePath = Array.isArray(controllerPath) ? controllerPath[0] : controllerPath;
        const cleanMethodPath = Array.isArray(methodPath) ? methodPath[0] : methodPath;
        const full = `/api/v1/${cleanBasePath}/${cleanMethodPath}`
          .replace(/\/+/g, "/")
          .replace(/\/$/, "");

        const reqPerm = reflector.get(REQUIRED_PERMISSIONS_KEY, handler);
        const isPub = reflector.get(IS_PUBLIC_KEY, handler);
        const pubJust = reflector.get(PUBLIC_JUSTIFICATION_KEY, handler);
        const isAuth = reflector.get(IS_AUTHENTICATED_KEY, handler);
        const authJust = reflector.get(AUTHENTICATED_JUSTIFICATION_KEY, handler);

        let type = "UNKNOWN";
        if (reqPerm) {
          const permCodes = Array.isArray(reqPerm)
            ? reqPerm
                .map((p) => (typeof p === "object" && p && "code" in p ? p.code : String(p)))
                .join(",")
            : String(reqPerm);
          type = `RBAC: ${permCodes}`;
        } else if (isAuth) {
          type = `AUTH: ${authJust}`;
        } else if (isPub) {
          type = `PUBLIC: ${pubJust}`;
        }

        discovered.push(
          `${httpMethod.padEnd(6)} ${full.padEnd(45)} ${metatype.name}.${methodName.padEnd(30)} ${type}`,
        );
      }
    }

    discovered.sort();
    expect(discovered).toHaveLength(44);
    expect(discovered).toMatchSnapshot();
  });
});
