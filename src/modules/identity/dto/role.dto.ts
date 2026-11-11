import { z } from "zod";

export const createRoleSchema = z.object({
  name: z.string().min(2, "Role name must be at least 2 characters").max(50),
  slug: z
    .string()
    .min(2)
    .max(50)
    .regex(
      /^[a-z0-9_-]+$/,
      "Slug must contain only lowercase letters, numbers, hyphens, and underscores",
    ),
  description: z.string().max(255).optional(),
  permissionCodes: z.array(z.string().min(3)).min(1, "At least one permission is required"),
});

export type CreateRoleDto = z.infer<typeof createRoleSchema>;

export const updateRoleSchema = z.object({
  name: z.string().min(2).max(50).optional(),
  description: z.string().max(255).optional(),
  permissionCodes: z.array(z.string().min(3)).optional(),
});

export type UpdateRoleDto = z.infer<typeof updateRoleSchema>;

export const cloneRoleSchema = z.object({
  name: z.string().min(2, "Role name must be at least 2 characters").max(50),
  slug: z
    .string()
    .min(2)
    .max(50)
    .regex(
      /^[a-z0-9_-]+$/,
      "Slug must contain only lowercase letters, numbers, hyphens, and underscores",
    ),
  description: z.string().max(255).optional(),
});

export type CloneRoleDto = z.infer<typeof cloneRoleSchema>;

export const assignRoleSchema = z.object({
  userId: z.string().uuid("Invalid user ID UUID"),
  roleId: z.string().uuid("Invalid role ID UUID"),
});

export type AssignRoleDto = z.infer<typeof assignRoleSchema>;
