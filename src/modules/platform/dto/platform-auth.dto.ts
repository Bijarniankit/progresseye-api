import { z } from "zod";

export const PlatformLoginSchema = z.object({
  email: z.string().email("A valid email address is required."),
  password: z.string().min(1, "Password is required."),
});

export type PlatformLoginDto = z.infer<typeof PlatformLoginSchema>;

export const Platform2FaVerifySchema = z.object({
  code: z
    .string()
    .trim()
    .min(6, "Verification code must be at least 6 characters.")
    .max(16, "Verification code cannot exceed 16 characters."),
});

export type Platform2FaVerifyDto = z.infer<typeof Platform2FaVerifySchema>;

export const Platform2FaEnableSchema = z.object({
  code: z
    .string()
    .trim()
    .length(6, "TOTP verification code must be exactly 6 digits.")
    .regex(/^\d{6}$/, "TOTP code must consist of digits only."),
});

export type Platform2FaEnableDto = z.infer<typeof Platform2FaEnableSchema>;
