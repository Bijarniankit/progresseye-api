import { applyDecorators, SetMetadata } from "@nestjs/common";

export const IS_AUTHENTICATED_KEY = "isAuthenticated";
export const AUTHENTICATED_JUSTIFICATION_KEY = "authenticatedJustification";

/**
 * Marks an endpoint as requiring an authenticated session (valid Bearer access token)
 * but exempt from granular RBAC permission checks (e.g. self-service user operations
 * like logout, sessions, getMe, changePassword, 2FA setup).
 * A non-empty justification string explaining the access model is mandatory.
 */
export const Authenticated = (justification: string) => {
  if (!justification || justification.trim().length === 0) {
    throw new Error("@Authenticated() decorator requires a non-empty justification string.");
  }
  return applyDecorators(
    SetMetadata(IS_AUTHENTICATED_KEY, true),
    SetMetadata(AUTHENTICATED_JUSTIFICATION_KEY, justification.trim()),
  );
};
