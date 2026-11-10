import { createZodDto } from "nestjs-zod";
import { z } from "zod";

export const FirstLoginPasswordSchema = z.object({
  newPassword: z.string().min(12, "New password must be at least 12 characters").max(128),
});

export class FirstLoginPasswordDto extends createZodDto(FirstLoginPasswordSchema) {}
