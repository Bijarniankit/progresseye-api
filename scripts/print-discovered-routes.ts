import { METHOD_METADATA, PATH_METADATA } from "@nestjs/common/constants";
import { DiscoveryModule, DiscoveryService, MetadataScanner, Reflector } from "@nestjs/core";
import { Test } from "@nestjs/testing";
import { AppModule } from "../src/app.module";
import {
  AUTHENTICATED_JUSTIFICATION_KEY,
  IS_AUTHENTICATED_KEY,
} from "../src/common/decorators/authenticated.decorator";
import { IS_PUBLIC_KEY, PUBLIC_JUSTIFICATION_KEY } from "../src/common/decorators/public.decorator";
import { REQUIRED_PERMISSIONS_KEY } from "../src/common/decorators/require-permission.decorator";

async function run() {
  process.env.DATABASE_URL =
    process.env.DATABASE_URL || "postgresql://postgres:postgres@localhost:5432/test_db";
  const moduleRef = await Test.createTestingModule({
    imports: [AppModule, DiscoveryModule],
  }).compile();

  const discovery = moduleRef.get(DiscoveryService);
  const metadataScanner = moduleRef.get(MetadataScanner);
  const reflector = moduleRef.get(Reflector);

  const controllers = discovery.getControllers();
  const results: any[] = [];

  for (const c of controllers) {
    if (!c.instance || !c.metatype) continue;
    const controllerPath = Reflect.getMetadata(PATH_METADATA, c.metatype) || "";
    const proto = Object.getPrototypeOf(c.instance);
    const methods = metadataScanner.getAllMethodNames(proto);

    for (const m of methods) {
      const handler = proto[m];
      const methodPath = reflector.get(PATH_METADATA, handler);
      const httpCode = reflector.get(METHOD_METADATA, handler);
      if (methodPath === undefined || httpCode === undefined) continue;

      const httpMethod =
        ["GET", "POST", "PUT", "DELETE", "PATCH", "ALL", "OPTIONS", "HEAD"][httpCode] || "UNKNOWN";
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

      results.push({ httpMethod, full, handler: `${c.metatype.name}.${m}`, type });
    }
  }

  results.sort((a, b) => a.full.localeCompare(b.full) || a.httpMethod.localeCompare(b.httpMethod));
  console.log(`TOTAL DISCOVERED ROUTES: ${results.length}`);
  for (const r of results) {
    console.log(`${r.httpMethod.padEnd(6)} ${r.full.padEnd(45)} ${r.handler.padEnd(40)} ${r.type}`);
  }

  await moduleRef.close();
}

run().catch(console.error);
