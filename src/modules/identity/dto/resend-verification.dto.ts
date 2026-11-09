import { createZodDto } from "nestjs-zod";
import { z } from "zod";

export const ResendVerificationSchema = z.object({
  schoolSlug: z.string().min(1, "School slug is required").max(100),
  email: z.string().email("Invalid email format").max(255),
});

export class ResendVerificationDto extends createZodDto(ResendVerificationSchema) {}
