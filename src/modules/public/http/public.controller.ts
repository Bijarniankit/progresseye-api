import { Body, Controller, HttpCode, HttpStatus, Post, Req, UsePipes } from "@nestjs/common";
import { ApiOperation, ApiResponse, ApiTags } from "@nestjs/swagger";
import type { FastifyRequest } from "fastify";
import { ZodValidationPipe } from "../../../common/pipes/zod-validation.pipe";
import { PublicLeadService } from "../application/public-lead.service";
import {
  ContactLeadDto,
  ContactLeadSchema,
  DemoLeadDto,
  DemoLeadSchema,
  NewsletterLeadDto,
  NewsletterLeadSchema,
  PublicLeadResponseDto,
} from "../dto";

@ApiTags("Public")
@Controller("public")
export class PublicController {
  constructor(private readonly leadService: PublicLeadService) {}

  @Post("contact")
  @HttpCode(HttpStatus.CREATED)
  @UsePipes(new ZodValidationPipe(ContactLeadSchema))
  @ApiOperation({
    summary: "Submit contact inquiry",
    description: "Registers an institutional contact inquiry from the public marketing website.",
  })
  @ApiResponse({
    status: 201,
    description: "Inquiry received successfully",
    type: PublicLeadResponseDto,
  })
  @ApiResponse({
    status: 400,
    description: "Validation error or invalid submission (RFC 9457)",
  })
  async submitContact(
    @Body() dto: ContactLeadDto,
    @Req() req: FastifyRequest,
  ): Promise<PublicLeadResponseDto> {
    const meta = {
      ip: req.ip,
      userAgent: req.headers["user-agent"],
    };
    return this.leadService.submitContact(dto, meta);
  }

  @Post("demo")
  @HttpCode(HttpStatus.CREATED)
  @UsePipes(new ZodValidationPipe(DemoLeadSchema))
  @ApiOperation({
    summary: "Request institutional demo",
    description: "Schedules an educational product walkthrough and demo preview.",
  })
  @ApiResponse({
    status: 201,
    description: "Demo request received successfully",
    type: PublicLeadResponseDto,
  })
  @ApiResponse({
    status: 400,
    description: "Validation error or invalid submission (RFC 9457)",
  })
  async submitDemo(
    @Body() dto: DemoLeadDto,
    @Req() req: FastifyRequest,
  ): Promise<PublicLeadResponseDto> {
    const meta = {
      ip: req.ip,
      userAgent: req.headers["user-agent"],
    };
    return this.leadService.submitDemo(dto, meta);
  }

  @Post("newsletter")
  @HttpCode(HttpStatus.CREATED)
  @UsePipes(new ZodValidationPipe(NewsletterLeadSchema))
  @ApiOperation({
    summary: "Subscribe to product updates",
    description: "Registers an email address for product release updates and announcements.",
  })
  @ApiResponse({
    status: 201,
    description: "Subscribed to updates successfully",
    type: PublicLeadResponseDto,
  })
  @ApiResponse({
    status: 400,
    description: "Validation error or invalid submission (RFC 9457)",
  })
  async submitNewsletter(
    @Body() dto: NewsletterLeadDto,
    @Req() req: FastifyRequest,
  ): Promise<PublicLeadResponseDto> {
    const meta = {
      ip: req.ip,
      userAgent: req.headers["user-agent"],
    };
    return this.leadService.submitNewsletter(dto, meta);
  }
}
