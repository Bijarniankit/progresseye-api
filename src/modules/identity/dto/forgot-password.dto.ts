import { createZodDto } from "nestjs-zod";
import { z } from "zod";

export const ForgotPasswordSchema = z.object({
  schoolSlug: z.string().min(1, "School slug is required").max(100),
  email: z.string().email("Invalid email format").max(255),
});

export class ForgotPasswordDto extends createZodDto(ForgotPasswordSchema) {}
