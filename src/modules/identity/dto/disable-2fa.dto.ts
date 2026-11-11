import { createZodDto } from "nestjs-zod";
import { z } from "zod";

export const Disable2FaSchema = z.object({
  password: z.string().min(1, "Current password is required"),
  code: z
    .string()
    .length(6, "Verification code must be exactly 6 digits")
    .regex(/^\d{6}$/, "Verification code must be 6 numeric digits"),
});

export class Disable2FaDto extends createZodDto(Disable2FaSchema) {}
