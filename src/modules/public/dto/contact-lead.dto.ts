import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { z } from "zod";

export const ContactLeadSchema = z.object({
  name: z
    .string()
    .trim()
    .min(2, "Name must be at least 2 characters")
    .max(100, "Name cannot exceed 100 characters"),
  email: z.string().trim().email("Valid email address is required").max(255),
  schoolName: z
    .string()
    .trim()
    .min(2, "School name must be at least 2 characters")
    .max(150, "School name cannot exceed 150 characters"),
  message: z
    .string()
    .trim()
    .min(10, "Message must be at least 10 characters")
    .max(2000, "Message cannot exceed 2000 characters"),
  consentGiven: z.literal(true, {
    errorMap: () => ({ message: "Consent is required to submit this form" }),
  }),
  website_url: z.string().optional(),
});

export class ContactLeadDto {
  @ApiProperty({
    description: "Contact person's full name",
    minLength: 2,
    maxLength: 100,
    example: "Dr. A. Sharma",
  })
  name!: string;

  @ApiProperty({
    description: "Contact email address",
    maxLength: 255,
    example: "principal@delhischool.edu.in",
  })
  email!: string;

  @ApiProperty({
    description: "Name of the educational institution",
    minLength: 2,
    maxLength: 150,
    example: "Delhi Public School",
  })
  schoolName!: string;

  @ApiProperty({
    description: "Inquiry details or message",
    minLength: 10,
    maxLength: 2000,
    example: "We would like to learn more about attendance tracking.",
  })
  message!: string;

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
