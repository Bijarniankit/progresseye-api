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
});
