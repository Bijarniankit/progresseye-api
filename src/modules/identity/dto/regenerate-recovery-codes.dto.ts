import { createZodDto } from "nestjs-zod";
import { z } from "zod";

export const RegenerateRecoveryCodesSchema = z.object({
  password: z.string().min(1, "Current password is required"),
});

export class RegenerateRecoveryCodesDto extends createZodDto(RegenerateRecoveryCodesSchema) {}
