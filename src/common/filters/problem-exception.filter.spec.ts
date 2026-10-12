import { type ArgumentsHost, HttpStatus, NotFoundException } from "@nestjs/common";
import { ErrorCode } from "../errors/error-codes.enum";
import { ProblemExceptionFilter } from "./problem-exception.filter";

describe("ProblemExceptionFilter", () => {
  let filter: ProblemExceptionFilter;
  let mockReply: {
    status: jest.Mock;
    header: jest.Mock;
    send: jest.Mock;
  };
  let mockRequest: {
    url: string;
    method: string;
    headers: Record<string, string>;
    id: string;
  };
  let mockHost: {
    switchToHttp: () => {
      getResponse: () => typeof mockReply;
      getRequest: () => typeof mockRequest;
    };
  };

  beforeEach(() => {
    filter = new ProblemExceptionFilter();
    mockReply = {
      status: jest.fn().mockReturnThis(),
      header: jest.fn().mockReturnThis(),
      send: jest.fn(),
    };
    mockRequest = {
      url: "/api/v1/test",
      method: "GET",
      headers: { "x-request-id": "test-req-123" },
      id: "req-internal-1",
    };
    mockHost = {
      switchToHttp: () => ({
        getResponse: () => mockReply,
        getRequest: () => mockRequest,
      }),
    };
  });

  it("should format NotFoundException into RFC 9457 problem+json", () => {
    const exception = new NotFoundException("Resource was not found");

    filter.catch(exception, mockHost as unknown as ArgumentsHost);

    expect(mockReply.status).toHaveBeenCalledWith(HttpStatus.NOT_FOUND);
    expect(mockReply.header).toHaveBeenCalledWith("Content-Type", "application/problem+json");
    expect(mockReply.send).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "https://api.progresseye.com/errors/NOT_FOUND",
        status: HttpStatus.NOT_FOUND,
        title: "Resource Not Found",
        detail: "Resource was not found",
        code: ErrorCode.NOT_FOUND,
        traceId: "test-req-123",
      }),
    );
  });

  it("should format unexpected errors into 500 INTERNAL_SERVER_ERROR", () => {
    const error = new Error("Database network failure");

    filter.catch(error, mockHost as unknown as ArgumentsHost);

    expect(mockReply.status).toHaveBeenCalledWith(HttpStatus.INTERNAL_SERVER_ERROR);
    expect(mockReply.send).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "https://api.progresseye.com/errors/INTERNAL_SERVER_ERROR",
        status: HttpStatus.INTERNAL_SERVER_ERROR,
        code: ErrorCode.INTERNAL_SERVER_ERROR,
      }),
    );
  });
});
