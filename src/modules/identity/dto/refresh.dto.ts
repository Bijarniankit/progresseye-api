import { createZodDto } from "nestjs-zod";
import { z } from "zod";

export const RefreshSchema = z.object({
  refreshToken: z.string().optional(),
  clientType: z.enum(["web", "mobile"]).optional(),
});

export class RefreshDto extends createZodDto(RefreshSchema) {}
