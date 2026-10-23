import { ApiProperty } from "@nestjs/swagger";

export class PublicLeadResponseDto {
  @ApiProperty({
    description: "Unique lead registration ID",
    example: "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d",
  })
  id!: string;

  @ApiProperty({
    description: "Receipt status",
    example: "received",
  })
  status!: "received";

  @ApiProperty({
    description: "User-facing acknowledgement message",
    example: "Inquiry received successfully",
  })
  message!: string;

  @ApiProperty({
    description: "UTC ISO timestamp when lead was received",
    example: "2026-10-24T10:00:00.000Z",
  })
  createdAt!: string;
}
