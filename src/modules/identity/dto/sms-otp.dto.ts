import { createZodDto } from "nestjs-zod";
import { z } from "zod";

export const SmsOtpSchema = z.object({
  schoolSlug: z.string().min(1, "School slug is required"),
  email: z.string().email("Valid email address is required"),
  phoneNumber: z.string().min(7, "Phone number must be at least 7 characters"),
});

export class SmsOtpDto extends createZodDto(SmsOtpSchema) {}
