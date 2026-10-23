import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { z } from "zod";

export const DemoLeadSchema = z.object({
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
  notes: z.string().trim().max(1000, "Notes cannot exceed 1000 characters").optional(),
  preferredTime: z.string().trim().max(100).optional(),
  consentGiven: z.literal(true, {
    errorMap: () => ({ message: "Consent is required to schedule a demo" }),
  }),
  website_url: z.string().optional(),
});

export class DemoLeadDto {
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

  @ApiPropertyOptional({
    description: "Additional institution details or inquiry notes",
    maxLength: 1000,
    example: "Evaluating SIS replacement for 2027 academic session.",
  })
  notes?: string;

  @ApiPropertyOptional({
    description: "Preferred demonstration timing",
    maxLength: 100,
    example: "Morning (9 AM - 12 PM)",
  })
  preferredTime?: string;

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
