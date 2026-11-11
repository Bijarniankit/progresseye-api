import { createZodDto } from "nestjs-zod";
import { z } from "zod";

export const RecoveryCodeVerifySchema = z.object({
  temporaryToken: z.string().min(1, "Temporary token is required"),
  recoveryCode: z.string().min(8, "Recovery code must be provided"),
});

export class RecoveryCodeVerifyDto extends createZodDto(RecoveryCodeVerifySchema) {}
