import { applyDecorators, SetMetadata } from "@nestjs/common";

export const IS_PUBLIC_KEY = "isPublic";
export const PUBLIC_JUSTIFICATION_KEY = "publicJustification";

/**
 * Marks an endpoint as explicitly exempt from authentication and permission checks.
 * A non-empty justification explaining the public exposure is mandatory.
 */
export const Public = (justification: string) => {
  if (!justification || justification.trim().length === 0) {
    throw new Error("@Public() decorator requires a non-empty justification string.");
  }
  return applyDecorators(
    SetMetadata(IS_PUBLIC_KEY, true),
    SetMetadata(PUBLIC_JUSTIFICATION_KEY, justification.trim()),
  );
};
