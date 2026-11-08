import { createZodDto } from "nestjs-zod";
import { z } from "zod";

export const ChangePasswordSchema = z.object({
  currentPassword: z.string().min(1, "Current password is required"),
  newPassword: z.string().min(12, "New password must be at least 12 characters").max(128),
});

export class ChangePasswordDto extends createZodDto(ChangePasswordSchema) {}
