import { createZodDto } from "nestjs-zod";
import { z } from "zod";

export const LoginSchema = z.object({
  schoolSlug: z
    .string()
    .min(1, "School slug is required")
    .max(100)
    .regex(
      /^[a-z0-9-]+$/,
      "School slug must contain lowercase alphanumeric characters and hyphens",
    ),
  email: z.string().email("Invalid email format").max(255),
  password: z.string().min(1, "Password is required").max(128),
  clientType: z.enum(["web", "mobile"]).default("web"),
});

export class LoginDto extends createZodDto(LoginSchema) {}
