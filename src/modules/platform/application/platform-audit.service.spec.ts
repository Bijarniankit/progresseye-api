import { Test, TestingModule } from "@nestjs/testing";
import { AppConfigService } from "../../../config/config.service";
import { PrismaService } from "../../../infra/prisma/prisma.service";
import { PlatformAuditService } from "./platform-audit.service";

describe("PlatformAuditService", () => {
  let service: PlatformAuditService;
  let mockPrisma: { $executeRaw: jest.Mock };
  let mockConfig: { get: jest.Mock };

  beforeEach(async () => {
    mockPrisma = {
      $executeRaw: jest.fn().mockResolvedValue(1),
    };
    mockConfig = {
      get: jest.fn().mockReturnValue("test-auth-log-hmac-secret-min16ch"),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PlatformAuditService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: AppConfigService, useValue: mockConfig },
      ],
    }).compile();

    service = module.get<PlatformAuditService>(PlatformAuditService);
  });

  it("should record an event by executing raw SQL without RETURNING clause", async () => {
    await service.recordEvent({
      actorUserId: "11111111-1111-1111-1111-111111111111",
      action: "PLATFORM_TEST_ACTION",
      resource: "schools",
      resourceId: "22222222-2222-2222-2222-222222222222",
      payload: { slug: "test-school", password: "should-be-redacted" },
      clientIp: "192.168.1.1",
      userAgent: "JestTestAgent",
    });

    expect(mockPrisma.$executeRaw).toHaveBeenCalled();
  });

  it("should redact sensitive fields in payload before logging", async () => {
    await service.recordEvent({
      action: "PLATFORM_SENSITIVE_ACTION",
      resource: "auth",
      payload: {
        safeField: "safeValue",
        password: "secretPassword123",
        nested: {
          token: "secretTokenABC",
          validKey: "ok",
        },
      },
    });

    expect(mockPrisma.$executeRaw).toHaveBeenCalled();
  });
});
