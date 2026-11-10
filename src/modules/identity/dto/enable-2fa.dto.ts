import { createZodDto } from "nestjs-zod";
import { z } from "zod";

export const Enable2FaSchema = z.object({
  code: z
    .string()
    .length(6, "Verification code must be exactly 6 digits")
    .regex(/^\d{6}$/, "Verification code must be 6 numeric digits"),
});

export class Enable2FaDto extends createZodDto(Enable2FaSchema) {}
