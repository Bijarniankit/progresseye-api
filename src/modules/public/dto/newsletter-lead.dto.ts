import { createZodDto } from "nestjs-zod";
import { z } from "zod";
import { normalizeEmail } from "../../../common/utils/sanitization";

export const NewsletterLeadSchema = z
  .object({
    email: z
      .string()
      .transform(normalizeEmail)
      .pipe(z.string().email("Valid email address is required").max(255)),
    consentGiven: z.literal(true, {
      message: "Consent is required to subscribe",
    }),
    website_url: z.string().optional(),
    turnstileToken: z.string().optional(),
  })
  .strict();

export class NewsletterLeadDto extends createZodDto(NewsletterLeadSchema) {}
