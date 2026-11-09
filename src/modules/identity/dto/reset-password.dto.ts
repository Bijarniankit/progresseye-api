import { createZodDto } from "nestjs-zod";
import { z } from "zod";

export const ResetPasswordSchema = z.object({
  token: z.string().min(1, "Reset token is required"),
  newPassword: z.string().min(12, "New password must be at least 12 characters").max(128),
});

export class ResetPasswordDto extends createZodDto(ResetPasswordSchema) {}
