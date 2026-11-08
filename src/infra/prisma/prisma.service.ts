import { Injectable, type OnModuleDestroy, type OnModuleInit, Optional } from "@nestjs/common";
import { type Prisma, PrismaClient } from "@prisma/client";
import { TenantContextService } from "../../common/request-context/tenant-context.service";

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private _tenantClient: any;

  constructor(
    @Optional() private readonly tenantContext?: TenantContextService,
    @Optional() options?: ConstructorParameters<typeof PrismaClient>[0],
  ) {
    super(options);
  }

  async onModuleInit(): Promise<void> {
    try {
      await this.$connect();
    } catch {
      // In development or when database is offline, allow app initialization
      // so health/live and offline tooling remain accessible
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }

  async ping(): Promise<boolean> {
    try {
      await this.$queryRawUnsafe("SELECT 1");
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Helper to set tenant context in raw SQL safely via parameterized query
   */
  async setTenantContext(schoolId: string): Promise<void> {
    if (this.tenantContext) {
      this.tenantContext.validateTenantId(schoolId);
    }
    await this.$executeRaw`SELECT set_config('app.current_school_id', ${schoolId}, true)`;
  }

  /**
   * Executes a callback within a single tenant-scoped transaction.
   * Runs `SELECT set_config('app.current_school_id', $1, true)` once on the
   * transaction connection and passes `tx` to the caller. If the callback
   * throws, the transaction rolls back cleanly.
   */
  async withTenant<T>(
    schoolId: string,
    fn: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    if (this.tenantContext) {
      this.tenantContext.validateTenantId(schoolId);
    }
    return this.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.current_school_id', ${schoolId}, true)`;
      return fn(tx);
    });
  }

  /**
   * Returns a Prisma Client instance extended to enforce tenant scoping on individual operations.
   * If an active schoolId exists in TenantContextService, routes operations through withTenant.
   * Forbids nested $transaction on the extended client to prevent accidental nested connection leakage.
   */
  get client(): this {
    if (!this.tenantContext) {
      return this;
    }
    if (!this._tenantClient) {
      const tc = this.tenantContext;
      const basePrisma = this;

      this._tenantClient = this.$extends({
        client: {
          async $transaction() {
            throw new Error(
              "Nested $transaction is not permitted on tenant-scoped client. Use prisma.withTenant(schoolId, fn) for transactional workflows.",
            );
          },
        },
        query: {
          $allModels: {
            async $allOperations({ model, operation, args, query }) {
              const schoolId = tc.getTenantId();
              if (!schoolId) {
                return query(args);
              }
              return basePrisma.withTenant(schoolId, async (tx) => {
                const modelKey = (model.charAt(0).toLowerCase() +
                  model.slice(1)) as keyof Prisma.TransactionClient;
                const delegate = tx[modelKey] as
                  | Record<string, ((a: unknown) => Promise<unknown>) | undefined>
                  | undefined;
                const op = delegate?.[operation];
                if (typeof op === "function") {
                  return op(args);
                }
                return query(args);
              });
            },
          },
          async $queryRaw({ args, query }) {
            const schoolId = tc.getTenantId();
            if (!schoolId) {
              return query(args);
            }
            return basePrisma.withTenant(schoolId, async (tx) => {
              return (tx as unknown as { $queryRaw: (a: unknown) => Promise<unknown> }).$queryRaw(
                args,
              );
            });
          },
          async $executeRaw({ args, query }) {
            const schoolId = tc.getTenantId();
            if (!schoolId) {
              return query(args);
            }
            return basePrisma.withTenant(schoolId, async (tx) => {
              return (
                tx as unknown as { $executeRaw: (a: unknown) => Promise<unknown> }
              ).$executeRaw(args);
            });
          },
        },
      });
    }
    return this._tenantClient;
  }
}
