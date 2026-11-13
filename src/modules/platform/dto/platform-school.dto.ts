import { z } from "zod";

export const CreateSchoolSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, "Name is required.")
    .max(255, "Name cannot exceed 255 characters."),
  slug: z
    .string()
    .trim()
    .min(3, "Slug must be at least 3 characters.")
    .max(63, "Slug cannot exceed 63 characters.")
    .regex(
      /^[a-z0-9]+(-[a-z0-9]+)*$/,
      "Slug must contain lowercase alphanumeric characters separated by single hyphens.",
    ),
  organizationId: z.string().uuid("Invalid organization ID.").optional(),
});

export type CreateSchoolDto = z.infer<typeof CreateSchoolSchema>;
