import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { z } from "zod";

export const NewsletterLeadSchema = z.object({
  email: z.string().trim().email("Valid email address is required").max(255),
  consentGiven: z.literal(true, {
    errorMap: () => ({ message: "Consent is required to subscribe to updates" }),
  }),
  website_url: z.string().optional(),
});

export class NewsletterLeadDto {
  @ApiProperty({
    description: "Subscriber email address",
    maxLength: 255,
    example: "updates@school.edu.in",
  })
  email!: string;

  @ApiProperty({
    description: "Affirmative consent confirmation",
    example: true,
  })
  consentGiven!: true;

  @ApiPropertyOptional({
    description: "Honeypot field for bot detection (must be omitted or empty)",
  })
  website_url?: string;
}
