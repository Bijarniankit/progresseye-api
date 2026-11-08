import { createZodDto } from "nestjs-zod";
import { z } from "zod";

export const PasswordStrengthSchema = z.object({
  password: z.string().min(1, "Password is required").max(128),
  userInputs: z.array(z.string()).optional(),
});

export class PasswordStrengthDto extends createZodDto(PasswordStrengthSchema) {}
