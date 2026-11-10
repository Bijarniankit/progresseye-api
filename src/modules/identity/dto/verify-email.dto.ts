import { createZodDto } from "nestjs-zod";
import { z } from "zod";

export const VerifyEmailSchema = z.object({
  token: z.string().min(1, "Verification token is required"),
});

export class VerifyEmailDto extends createZodDto(VerifyEmailSchema) {}
