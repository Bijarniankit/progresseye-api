import { SetMetadata } from "@nestjs/common";

export const REQUIRED_PERMISSIONS_KEY = "requiredPermissions";

export interface PermissionRequirement {
  action: string;
  resource: string;
  code: string;
}

/**
 * Declares that an endpoint requires a specific permission.
 * Accepts either:
 * 1. Action and Resource: @RequirePermission("read", "identity.role")
 * 2. Full Permission Code: @RequirePermission("identity.role.read")
 */
export function RequirePermission(actionOrCode: string, resource?: string) {
  let requirement: PermissionRequirement;

  if (resource) {
    requirement = {
      action: actionOrCode,
      resource,
      code: `${resource}.${actionOrCode}`,
    };
  } else {
    const parts = actionOrCode.split(".");
    if (parts.length >= 3) {
      const action = parts[parts.length - 1] ?? "manage";
      const res = parts.slice(0, -1).join(".");
      requirement = {
        action,
        resource: res,
        code: actionOrCode,
      };
    } else {
      requirement = {
        action: actionOrCode,
        resource: "all",
        code: actionOrCode,
      };
    }
  }

  return SetMetadata(REQUIRED_PERMISSIONS_KEY, [requirement]);
}

/**
 * Declares that an endpoint requires multiple permissions (all must be satisfied).
 */
export function RequirePermissions(...requirements: PermissionRequirement[]) {
  return SetMetadata(REQUIRED_PERMISSIONS_KEY, requirements);
}
