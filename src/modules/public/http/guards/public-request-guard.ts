import {
  BadRequestException,
  type CanActivate,
  type ExecutionContext,
  Injectable,
  PayloadTooLargeException,
} from "@nestjs/common";
import type { FastifyRequest } from "fastify";

export const MAX_PUBLIC_PAYLOAD_BYTES = 16 * 1024; // 16 kB

@Injectable()
export class PublicRequestGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<FastifyRequest>();

    // Enforce POST method rules
    if (request.method === "POST") {
      const contentType = request.headers["content-type"];
      if (!contentType?.toLowerCase().includes("application/json")) {
        throw new BadRequestException("Content-Type must be application/json");
      }

      const contentLength = request.headers["content-length"];
      if (contentLength && Number.parseInt(contentLength, 10) > MAX_PUBLIC_PAYLOAD_BYTES) {
        throw new PayloadTooLargeException(
          `Request payload exceeds maximum allowed size of ${MAX_PUBLIC_PAYLOAD_BYTES} bytes (16 kB)`,
        );
      }
    }

    return true;
  }
}
