import {
  isPlatformPermission,
  PERMISSIONS_CATALOG,
  requiresTwoFactor,
  SENSITIVE_PERMISSIONS,
  SYSTEM_PLATFORM_ROLES,
  TENANT_BUILT_IN_ROLES,
} from "./permissions.catalog";

describe("Permissions Catalog (Phase 13b-1)", () => {
  it("should have exactly 43 total permissions in catalog (5 platform, 38 tenant)", () => {
    expect(PERMISSIONS_CATALOG).toHaveLength(43);

    const platformPerms = PERMISSIONS_CATALOG.filter((p) => isPlatformPermission(p.code));
    const tenantPerms = PERMISSIONS_CATALOG.filter((p) => !isPlatformPermission(p.code));

    expect(platformPerms).toHaveLength(5);
    expect(tenantPerms).toHaveLength(38);

    const expectedPlatformCodes = [
      "platform.school.create",
      "platform.school.read",
      "platform.school.update",
      "platform.plan.manage",
      "platform.invite.create",
    ];
    expect(platformPerms.map((p) => p.code).sort()).toEqual(expectedPlatformCodes.sort());
  });

  it("should verify every code in SENSITIVE_PERMISSIONS exists in PERMISSIONS_CATALOG", () => {
    const allCatalogCodes = new Set(PERMISSIONS_CATALOG.map((p) => p.code));
    expect(SENSITIVE_PERMISSIONS.length).toBeGreaterThan(0);
    for (const code of SENSITIVE_PERMISSIONS) {
      expect(allCatalogCodes.has(code)).toBe(true);
    }
  });

  it("should verify requiresTwoFactor covers platform_admin, principal, and accountant", () => {
    const platformAdmin = SYSTEM_PLATFORM_ROLES.find((r) => r.slug === "platform_admin");
    const principal = TENANT_BUILT_IN_ROLES.find((r) => r.slug === "principal");
    const accountant = TENANT_BUILT_IN_ROLES.find((r) => r.slug === "accountant");

    expect(platformAdmin).toBeDefined();
    expect(principal).toBeDefined();
    expect(accountant).toBeDefined();

    expect(requiresTwoFactor(platformAdmin!.permissions)).toBe(true);
    expect(requiresTwoFactor(principal!.permissions)).toBe(true);
    expect(requiresTwoFactor(accountant!.permissions)).toBe(true);
  });

  it("should verify non-administrative tenant roles do NOT require 2FA", () => {
    const nonSensitiveSlugs = [
      "teacher",
      "student",
      "parent",
      "librarian",
      "receptionist",
      "exam_coordinator",
      "transport_manager",
      "hostel_warden",
      "nurse",
      "counselor",
    ];

    for (const slug of nonSensitiveSlugs) {
      const role = TENANT_BUILT_IN_ROLES.find((r) => r.slug === slug);
      expect(role).toBeDefined();
      expect(requiresTwoFactor(role!.permissions)).toBe(false);
    }
  });

  it("should have exactly 1 system platform role (platform_admin) and 12 tenant built-in roles", () => {
    expect(SYSTEM_PLATFORM_ROLES).toHaveLength(1);
    expect(SYSTEM_PLATFORM_ROLES[0]?.slug).toBe("platform_admin");

    expect(TENANT_BUILT_IN_ROLES).toHaveLength(12);
  });

  it("should enforce that ZERO tenant roles hold any platform.* permissions", () => {
    for (const role of TENANT_BUILT_IN_ROLES) {
      const platformPermsInRole = role.permissions.filter((code) => isPlatformPermission(code));
      expect(platformPermsInRole).toHaveLength(0);
    }
  });

  it("should verify principal role holds exactly 38 non-platform tenant permissions", () => {
    const principalRole = TENANT_BUILT_IN_ROLES.find((r) => r.slug === "principal");
    expect(principalRole).toBeDefined();
    expect(principalRole?.permissions).toHaveLength(38);

    const tenantPermCodes = PERMISSIONS_CATALOG.filter((p) => !isPlatformPermission(p.code)).map(
      (p) => p.code,
    );
    expect(principalRole?.permissions.sort()).toEqual(tenantPermCodes.sort());
  });

  it("should verify hostel_warden role holds exactly 6 permissions", () => {
    const warden = TENANT_BUILT_IN_ROLES.find((r) => r.slug === "hostel_warden");
    expect(warden).toBeDefined();
    expect(warden?.permissions).toHaveLength(6);
    expect(warden?.permissions.sort()).toEqual(
      [
        "operations.hostel.read",
        "operations.hostel.write",
        "people.student.read",
        "attendance.record.read",
        "attendance.record.write",
        "communication.notice.read",
      ].sort(),
    );
  });

  it("should verify platform_admin holds only platform.* permissions", () => {
    const platformAdmin = SYSTEM_PLATFORM_ROLES[0];
    expect(platformAdmin).toBeDefined();
    expect(platformAdmin?.permissions.every((p) => isPlatformPermission(p))).toBe(true);
  });
});
