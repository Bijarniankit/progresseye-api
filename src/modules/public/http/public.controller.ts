import {
  Body,
  Controller,
  Headers,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  Res,
  UseGuards,
  UsePipes,
} from "@nestjs/common";
import { ApiBody, ApiOperation, ApiResponse, ApiTags } from "@nestjs/swagger";
import { Throttle } from "@nestjs/throttler";
import type { FastifyReply, FastifyRequest } from "fastify";
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
import { PublicRequestGuard } from "./guards/public-request-guard";

@ApiTags("Public")
@Controller("public")
@UseGuards(PublicRequestGuard)
export class PublicController {
  constructor(private readonly leadService: PublicLeadService) {}

  @Post("contact")
  @HttpCode(HttpStatus.CREATED)
  @Throttle({ default: { limit: 5, ttl: 900000 } }) // 5 requests / 15 min
  @UsePipes(new ZodValidationPipe(ContactLeadSchema))
  @ApiOperation({
    summary: "Submit contact inquiry",
    description: "Registers an institutional contact inquiry from the public marketing website.",
  })
  @ApiBody({ type: ContactLeadDto })
  @ApiResponse({
    status: 201,
    description: "Inquiry received successfully",
    type: PublicLeadResponseDto,
  })
  @ApiResponse({
    status: 400,
    description: "Validation error or invalid submission (RFC 9457)",
  })
  @ApiResponse({
    status: 413,
    description: "Payload too large (>16 kB) (RFC 9457)",
  })
  @ApiResponse({
    status: 422,
    description: "Unprocessable entity - idempotency key payload mismatch (RFC 9457)",
  })
  @ApiResponse({
    status: 429,
    description: "Rate limit exceeded (RFC 9457)",
  })
  async submitContact(
    @Body() dto: ContactLeadDto,
    @Req() req: FastifyRequest,
    @Res() reply: FastifyReply,
    @Headers("idempotency-key") idempotencyKey?: string,
  ): Promise<void> {
    const meta = {
      ip: req.ip,
      userAgent: req.headers["user-agent"],
      idempotencyKey,
    };
    const result = await this.leadService.submitContact(dto, meta);
    if (result.isReplayed) {
      reply.header("Idempotent-Replayed", "true");
    }
    reply.status(HttpStatus.CREATED).send(result.response);
  }

  @Post("demo")
  @HttpCode(HttpStatus.CREATED)
  @Throttle({ default: { limit: 5, ttl: 900000 } }) // 5 requests / 15 min
  @UsePipes(new ZodValidationPipe(DemoLeadSchema))
  @ApiOperation({
    summary: "Request institutional demo",
    description: "Schedules an educational product walkthrough and demo preview.",
  })
  @ApiBody({ type: DemoLeadDto })
  @ApiResponse({
    status: 201,
    description: "Demo request received successfully",
    type: PublicLeadResponseDto,
  })
  @ApiResponse({
    status: 400,
    description: "Validation error or invalid submission (RFC 9457)",
  })
  @ApiResponse({
    status: 413,
    description: "Payload too large (>16 kB) (RFC 9457)",
  })
  @ApiResponse({
    status: 422,
    description: "Unprocessable entity - idempotency key payload mismatch (RFC 9457)",
  })
  @ApiResponse({
    status: 429,
    description: "Rate limit exceeded (RFC 9457)",
  })
  async submitDemo(
    @Body() dto: DemoLeadDto,
    @Req() req: FastifyRequest,
    @Res() reply: FastifyReply,
    @Headers("idempotency-key") idempotencyKey?: string,
  ): Promise<void> {
    const meta = {
      ip: req.ip,
      userAgent: req.headers["user-agent"],
      idempotencyKey,
    };
    const result = await this.leadService.submitDemo(dto, meta);
    if (result.isReplayed) {
      reply.header("Idempotent-Replayed", "true");
    }
    reply.status(HttpStatus.CREATED).send(result.response);
  }

  @Post("newsletter")
  @HttpCode(HttpStatus.CREATED)
  @Throttle({ default: { limit: 10, ttl: 900000 } }) // 10 requests / 15 min
  @UsePipes(new ZodValidationPipe(NewsletterLeadSchema))
  @ApiOperation({
    summary: "Subscribe to product updates",
    description: "Registers an email address for product release updates and announcements.",
  })
  @ApiBody({ type: NewsletterLeadDto })
  @ApiResponse({
    status: 201,
    description: "Subscribed to updates successfully",
    type: PublicLeadResponseDto,
  })
  @ApiResponse({
    status: 400,
    description: "Validation error or invalid submission (RFC 9457)",
  })
  @ApiResponse({
    status: 413,
    description: "Payload too large (>16 kB) (RFC 9457)",
  })
  @ApiResponse({
    status: 422,
    description: "Unprocessable entity - idempotency key payload mismatch (RFC 9457)",
  })
  @ApiResponse({
    status: 429,
    description: "Rate limit exceeded (RFC 9457)",
  })
  async submitNewsletter(
    @Body() dto: NewsletterLeadDto,
    @Req() req: FastifyRequest,
    @Res() reply: FastifyReply,
    @Headers("idempotency-key") idempotencyKey?: string,
  ): Promise<void> {
    const meta = {
      ip: req.ip,
      userAgent: req.headers["user-agent"],
      idempotencyKey,
    };
    const result = await this.leadService.submitNewsletter(dto, meta);
    if (result.isReplayed) {
      reply.header("Idempotent-Replayed", "true");
    }
    reply.status(HttpStatus.CREATED).send(result.response);
  }
}
