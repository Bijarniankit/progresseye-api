import { createZodDto } from "nestjs-zod";
import { z } from "zod";

export const TotpVerifySchema = z.object({
  temporaryToken: z.string().min(1, "Temporary token is required"),
  code: z
    .string()
    .length(6, "Verification code must be exactly 6 digits")
    .regex(/^\d{6}$/, "Verification code must be 6 numeric digits"),
});

export class TotpVerifyDto extends createZodDto(TotpVerifySchema) {}
