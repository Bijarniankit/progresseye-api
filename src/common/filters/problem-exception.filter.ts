import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from "@nestjs/common";
import type { FastifyReply, FastifyRequest } from "fastify";
import { ErrorCode } from "../errors/error-codes.enum";
import type { ProblemDetails } from "../errors/problem-details";

@Catch()
export class ProblemExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(ProblemExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const reply = ctx.getResponse<FastifyReply>();
    const request = ctx.getRequest<FastifyRequest>();

    const status =
      exception instanceof HttpException
        ? exception.getStatus()
        : typeof (exception as { statusCode?: number })?.statusCode === "number"
          ? (exception as { statusCode: number }).statusCode
          : typeof (exception as { status?: number })?.status === "number"
            ? (exception as { status: number }).status
            : HttpStatus.INTERNAL_SERVER_ERROR;

    const traceId =
      (request.headers["x-request-id"] as string | undefined) ?? request.id ?? "unknown";

    const { code, title, detail, invalidParams } = this.extractErrorMetadata(exception, status);

    const problem: ProblemDetails = {
      type: `https://api.progresseye.in/errors/${code}`,
      title,
      status,
      detail,
      instance: request.url,
      code,
      timestamp: new Date().toISOString(),
      traceId,
      ...(invalidParams && invalidParams.length > 0 ? { invalidParams } : {}),
    };

    if (status >= 500) {
      this.logger.error(
        `[${traceId}] 5xx Error at ${request.method} ${request.url}: ${detail}`,
        exception instanceof Error ? exception.stack : undefined,
      );
    } else {
      this.logger.warn(
        `[${traceId}] ${status} ${code} at ${request.method} ${request.url}: ${detail}`,
      );
    }

    if (status === HttpStatus.TOO_MANY_REQUESTS) {
      if (!reply.getHeader("retry-after")) {
        reply.header("Retry-After", "900");
      }
    }

    reply.status(status).header("Content-Type", "application/problem+json").send(problem);
  }

  private extractErrorMetadata(
    exception: unknown,
    status: number,
  ): {
    code: ErrorCode;
    title: string;
    detail: string;
    invalidParams?: Array<{ name: string; reason: string }>;
  } {
    if (status === HttpStatus.PAYLOAD_TOO_LARGE) {
      return {
        code: ErrorCode.PAYLOAD_TOO_LARGE,
        title: "Payload Too Large",
        detail: "Request body size exceeds the allowable limit (16 kB).",
      };
    }

    if (exception instanceof HttpException) {
      const response = exception.getResponse();

      if (status === HttpStatus.TOO_MANY_REQUESTS) {
        return {
          code: ErrorCode.RATE_LIMIT_EXCEEDED,
          title: "Too Many Requests",
          detail: "Rate limit exceeded. Please wait before making more requests.",
        };
      }

      if (status === HttpStatus.UNPROCESSABLE_ENTITY) {
        return {
          code: ErrorCode.UNPROCESSABLE_ENTITY,
          title: "Unprocessable Entity",
          detail:
            typeof response === "string"
              ? response
              : (response as { message?: string }).message ||
                "The request payload could not be processed.",
        };
      }

      if (status === HttpStatus.NOT_FOUND) {
        return {
          code: ErrorCode.NOT_FOUND,
          title: "Resource Not Found",
          detail:
            typeof response === "string"
              ? response
              : (response as { message?: string }).message ||
                "The requested resource was not found.",
        };
      }

      if (status === HttpStatus.SERVICE_UNAVAILABLE) {
        return {
          code: ErrorCode.SERVICE_UNAVAILABLE,
          title: "Service Unavailable",
          detail:
            typeof response === "string"
              ? response
              : (response as { message?: string }).message ||
                "A required backend service is currently unavailable.",
        };
      }

      if (status === HttpStatus.BAD_REQUEST) {
        let detail = "Invalid request payload or parameters.";
        let code = ErrorCode.VALIDATION_ERROR;
        let invalidParams: Array<{ name: string; reason: string }> | undefined;

        if (typeof response === "object" && response !== null) {
          const resp = response as {
            code?: ErrorCode;
            message?: string | string[];
            errors?: Array<{ path?: string[]; message?: string }>;
          };

          if (resp.code && Object.values(ErrorCode).includes(resp.code)) {
            code = resp.code;
          }

          if (Array.isArray(resp.message)) {
            detail = resp.message.join("; ");
          } else if (typeof resp.message === "string") {
            detail = resp.message;
          }

          if (Array.isArray(resp.errors)) {
            invalidParams = resp.errors.map((e) => ({
              name: e.path?.join(".") || "parameter",
              reason: e.message || "Invalid value",
            }));
          }
        }

        return {
          code,
          title: "Bad Request",
          detail,
          invalidParams,
        };
      }

      const defaultTitle = HttpStatus[status] || "HTTP Exception";
      const detail =
        typeof response === "string"
          ? response
          : (response as { message?: string }).message || exception.message;

      return {
        code: this.statusCodeToErrorCode(status),
        title: defaultTitle,
        detail: Array.isArray(detail) ? detail.join("; ") : detail,
      };
    }

    return {
      code: ErrorCode.INTERNAL_SERVER_ERROR,
      title: "Internal Server Error",
      detail:
        process.env.NODE_ENV === "production"
          ? "An unexpected error occurred. Please contact support."
          : exception instanceof Error
            ? exception.message
            : "An unexpected error occurred.",
    };
  }

  private statusCodeToErrorCode(status: number): ErrorCode {
    switch (status) {
      case HttpStatus.BAD_REQUEST:
        return ErrorCode.BAD_REQUEST;
      case HttpStatus.UNAUTHORIZED:
        return ErrorCode.UNAUTHORIZED;
      case HttpStatus.FORBIDDEN:
        return ErrorCode.FORBIDDEN;
      case HttpStatus.NOT_FOUND:
        return ErrorCode.NOT_FOUND;
      case HttpStatus.CONFLICT:
        return ErrorCode.CONFLICT;
      case HttpStatus.UNPROCESSABLE_ENTITY:
        return ErrorCode.UNPROCESSABLE_ENTITY;
      case HttpStatus.PAYLOAD_TOO_LARGE:
        return ErrorCode.PAYLOAD_TOO_LARGE;
      case HttpStatus.TOO_MANY_REQUESTS:
        return ErrorCode.RATE_LIMIT_EXCEEDED;
      case HttpStatus.SERVICE_UNAVAILABLE:
        return ErrorCode.SERVICE_UNAVAILABLE;
      default:
        return ErrorCode.INTERNAL_SERVER_ERROR;
    }
  }
}
