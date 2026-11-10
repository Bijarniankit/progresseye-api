import { createZodDto } from "nestjs-zod";
import { z } from "zod";

export const UserSummarySchema = z.object({
  id: z.string().uuid(),
  email: z.string().email(),
  firstName: z.string(),
  lastName: z.string(),
  mustChangePassword: z.boolean(),
  roles: z.array(z.string()),
  isTwoFactorEnabled: z.boolean().optional(),
});

export const LoginResponseSchema = z.object({
  accessToken: z.string().optional(),
  expiresIn: z.number(),
  user: UserSummarySchema,
  refreshToken: z.string().optional(),
  mustChangePassword: z.boolean().optional(),
  requires2Fa: z.boolean().optional(),
  temporaryToken: z.string().optional(),
});

export class LoginResponseDto extends createZodDto(LoginResponseSchema) {}

export const GenericMessageResponseSchema = z.object({
  message: z.string(),
});

export class GenericMessageResponseDto extends createZodDto(GenericMessageResponseSchema) {}

export const RefreshResponseSchema = z.object({
  accessToken: z.string(),
  expiresIn: z.number(),
  refreshToken: z.string().optional(),
});

export class RefreshResponseDto extends createZodDto(RefreshResponseSchema) {}

export const SessionItemSchema = z.object({
  id: z.string().uuid(),
  clientType: z.string(),
  userAgent: z.string().nullable(),
  ipAddress: z.string().nullable(),
  createdAt: z.string(),
  expiresAt: z.string(),
  isCurrent: z.boolean(),
});

export const SessionListSchema = z.object({
  sessions: z.array(SessionItemSchema),
});

export class SessionListDto extends createZodDto(SessionListSchema) {}

export const TwoFactorSetupResponseSchema = z.object({
  secret: z.string(),
  uri: z.string(),
});

export class TwoFactorSetupResponseDto extends createZodDto(TwoFactorSetupResponseSchema) {}

export const TwoFactorEnableResponseSchema = z.object({
  recoveryCodes: z.array(z.string()),
});

export class TwoFactorEnableResponseDto extends createZodDto(TwoFactorEnableResponseSchema) {}
