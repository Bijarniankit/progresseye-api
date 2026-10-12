import type { ErrorCode } from "./error-codes.enum";

export interface ProblemDetails {
  type: string;
  title: string;
  status: number;
  detail: string;
  instance?: string;
  code: ErrorCode;
  timestamp: string;
  traceId?: string;
  invalidParams?: Array<{
    name: string;
    reason: string;
  }>;
}
