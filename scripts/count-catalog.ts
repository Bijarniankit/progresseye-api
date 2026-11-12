import {
  PERMISSIONS_CATALOG,
  requiresTwoFactor,
  SENSITIVE_PERMISSIONS,
  SYSTEM_PLATFORM_ROLES,
  TENANT_BUILT_IN_ROLES,
} from "../src/modules/identity/domain/permissions.catalog";

console.log("=== PERMISSIONS CATALOG VERIFICATION SCRIPT ===");
console.log(`TOTAL_CATALOG_PERMISSIONS: ${PERMISSIONS_CATALOG.length}`);

const catalogCodes = new Set(PERMISSIONS_CATALOG.map((p) => p.code));
console.log(`TOTAL_SENSITIVE_PERMISSIONS: ${SENSITIVE_PERMISSIONS.length}`);

let unknownCount = 0;
for (const s of SENSITIVE_PERMISSIONS) {
  if (!catalogCodes.has(s)) {
    console.error(`ERROR: SENSITIVE_PERMISSIONS code NOT in catalog: ${s}`);
    unknownCount++;
  } else {
    console.log(`OK: ${s}`);
  }
}

if (unknownCount > 0) {
  console.error(`FAILED: ${unknownCount} unknown codes found in SENSITIVE_PERMISSIONS`);
  process.exit(1);
} else {
  console.log("SUCCESS: All SENSITIVE_PERMISSIONS exist in the 43-permission catalog.");
}

console.log("\n=== ROLE 2FA REQUIREMENT STATUS ===");
const roles = [...SYSTEM_PLATFORM_ROLES, ...TENANT_BUILT_IN_ROLES];
for (const role of roles) {
  const req2Fa = requiresTwoFactor(role.permissions);
  console.log(
    `${role.slug.padEnd(20)}: 2FA required = ${req2Fa} (${role.permissions.length} perms)`,
  );
}
