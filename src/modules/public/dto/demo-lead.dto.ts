import { createZodDto } from "nestjs-zod";
import { z } from "zod";
import { normalizeEmail, stripControlCharacters } from "../../../common/utils/sanitization";

export const DemoLeadSchema = z
  .object({
    name: z
      .string()
      .transform(stripControlCharacters)
      .pipe(
        z
          .string()
          .trim()
          .min(2, "Name must be at least 2 characters")
          .max(100, "Name cannot exceed 100 characters"),
      ),
    email: z
      .string()
      .transform(normalizeEmail)
      .pipe(z.string().email("Valid email address is required").max(255)),
    schoolName: z
      .string()
      .transform(stripControlCharacters)
      .pipe(
        z
          .string()
          .trim()
          .min(2, "School name must be at least 2 characters")
          .max(150, "School name cannot exceed 150 characters"),
      ),
    notes: z
      .string()
      .transform(stripControlCharacters)
      .pipe(z.string().trim().max(2000, "Notes cannot exceed 2000 characters"))
      .optional(),
    consentGiven: z.literal(true, {
      message: "Consent is required to submit this form",
    }),
    website_url: z.string().optional(),
    turnstileToken: z.string().optional(),
  })
  .strict();

export class DemoLeadDto extends createZodDto(DemoLeadSchema) {}
