import { BadRequestException } from "@nestjs/common";
import { uuidv7 } from "uuidv7";
import { TenantContextService } from "./tenant-context.service";

describe("TenantContextService", () => {
  let service: TenantContextService;

  beforeEach(() => {
    service = new TenantContextService();
  });

  it("should return undefined when no context is active", () => {
    expect(service.getTenantId()).toBeUndefined();
    expect(service.getContext()).toBeUndefined();
  });

  it("should successfully set and retrieve a valid UUIDv7 tenant ID within run context", async () => {
    const validSchoolId = uuidv7();

    await service.run({ schoolId: validSchoolId }, async () => {
      expect(service.getTenantId()).toBe(validSchoolId);
      expect(service.getContext()?.schoolId).toBe(validSchoolId);
    });

    expect(service.getTenantId()).toBeUndefined();
  });

  it("should reject Nil-UUID with BadRequestException", async () => {
    const nilUuid = "00000000-0000-0000-0000-000000000000";

    await expect(service.run({ schoolId: nilUuid }, async () => {})).rejects.toThrow(
      BadRequestException,
    );

    await expect(service.run({ schoolId: nilUuid }, async () => {})).rejects.toThrow(
      "Nil-UUID is not a valid tenant ID",
    );
  });

  it("should reject malformed non-UUID strings with BadRequestException", async () => {
    const malformed = "not-a-valid-uuid";

    await expect(service.run({ schoolId: malformed }, async () => {})).rejects.toThrow(
      BadRequestException,
    );

    await expect(service.run({ schoolId: malformed }, async () => {})).rejects.toThrow(
      "Malformed tenant ID: must be a valid UUID",
    );
  });

  it("should reject SQL injection payloads in tenant ID with BadRequestException", async () => {
    const sqlInjection = "'; DROP TABLE schools; --";

    await expect(service.run({ schoolId: sqlInjection }, async () => {})).rejects.toThrow(
      BadRequestException,
    );
  });
});
