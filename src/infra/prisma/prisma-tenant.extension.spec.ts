import { uuidv7 } from "uuidv7";
import { TenantContextService } from "../../common/request-context/tenant-context.service";
import { PrismaService } from "./prisma.service";

describe("Prisma Tenant Extension", () => {
  let tenantContext: TenantContextService;
  let prisma: PrismaService;

  beforeEach(() => {
    tenantContext = new TenantContextService();
    prisma = new PrismaService(tenantContext);
  });

  it("should cover model operations: set tenant context when schoolId is present", async () => {
    const schoolId = uuidv7();
    const mockExecuteRaw = jest.fn().mockResolvedValue(1);
    const mockFindMany = jest.fn().mockResolvedValue([]);

    // Mock $transaction to execute callback immediately
    const mockTx = {
      $executeRaw: mockExecuteRaw,
      user: {
        findMany: mockFindMany,
      },
    };
    prisma.$transaction = jest
      .fn()
      .mockImplementation(async (cb: (tx: any) => Promise<any>) => cb(mockTx));

    await tenantContext.run({ schoolId }, async () => {
      const client = prisma.client;
      await (client as any).user.findMany({ where: { isActive: true } });
    });

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(mockExecuteRaw).toHaveBeenCalledTimes(1);
    expect(mockFindMany).toHaveBeenCalledWith({ where: { isActive: true } });
  });

  it("should cover $queryRaw: set tenant context before executing raw query", async () => {
    const schoolId = uuidv7();
    const mockExecuteRaw = jest.fn().mockResolvedValue(1);
    const mockQueryRaw = jest.fn().mockResolvedValue([{ count: 5 }]);

    const mockTx = {
      $executeRaw: mockExecuteRaw,
      $queryRaw: mockQueryRaw,
    };
    prisma.$transaction = jest
      .fn()
      .mockImplementation(async (cb: (tx: any) => Promise<any>) => cb(mockTx));

    await tenantContext.run({ schoolId }, async () => {
      const client = prisma.client;
      await client.$queryRaw`SELECT count(*) FROM users`;
    });

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(mockExecuteRaw).toHaveBeenCalledTimes(1);
    expect(mockQueryRaw).toHaveBeenCalledTimes(1);
  });

  it("should cover $executeRaw: set tenant context before executing raw command", async () => {
    const schoolId = uuidv7();
    const mockExecuteRaw = jest.fn().mockResolvedValue(1);

    const mockTx = {
      $executeRaw: mockExecuteRaw,
    };
    prisma.$transaction = jest
      .fn()
      .mockImplementation(async (cb: (tx: any) => Promise<any>) => cb(mockTx));

    await tenantContext.run({ schoolId }, async () => {
      const client = prisma.client;
      await client.$executeRaw`UPDATE users SET is_active = true WHERE id = ${uuidv7()}`;
    });

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(mockExecuteRaw).toHaveBeenCalledTimes(2); // 1 for set_config, 1 for the update
  });

  it("should provide withTenant method that sets tenant context and passes tx", async () => {
    const schoolId = uuidv7();
    const mockExecuteRaw = jest.fn().mockResolvedValue(1);
    const mockTx = {
      $executeRaw: mockExecuteRaw,
      user: {
        findMany: jest.fn().mockResolvedValue([{ id: "u1" }]),
      },
    };
    prisma.$transaction = jest
      .fn()
      .mockImplementation(async (cb: (tx: any) => Promise<any>) => cb(mockTx));

    const result = await prisma.withTenant(schoolId, async (tx) => {
      return (tx as any).user.findMany();
    });

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(mockExecuteRaw).toHaveBeenCalledTimes(1);
    expect(result).toEqual([{ id: "u1" }]);
  });

  it("should forbid nested $transaction on the tenant-scoped extended client", async () => {
    const client = prisma.client;
    await expect((client as any).$transaction(async () => {})).rejects.toThrow(
      "Nested $transaction is not permitted on tenant-scoped client",
    );
  });
});
