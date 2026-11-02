import { Injectable, type OnModuleDestroy, type OnModuleInit, Optional } from "@nestjs/common";
import { PrismaClient } from "@prisma/client";
import { TenantContextService } from "../../common/request-context/tenant-context.service";

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private _tenantClient: any;

  constructor(@Optional() private readonly tenantContext?: TenantContextService) {
    super();
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
   * Returns a Prisma Client instance extended to enforce tenant scoping.
   * If an active schoolId exists in TenantContextService, wraps operations
   * in a transaction that runs SELECT set_config('app.current_school_id', $1, true).
   * Does not nest transactions if an outer transaction is already active.
   */
  get client(): this {
    if (!this.tenantContext) {
      return this;
    }
    if (!this._tenantClient) {
      const tc = this.tenantContext;
      const basePrisma = this;

      this._tenantClient = this.$extends({
        query: {
          $allModels: {
            async $allOperations({ model, operation, args, query }) {
              const schoolId = tc.getTenantId();
              if (!schoolId) {
                return query(args);
              }
              // Check if already inside an active transaction client (where $transaction is undefined)
              const isTransactionClient = typeof (basePrisma as any).$transaction !== "function";
              if (isTransactionClient) {
                await (basePrisma as any)
                  .$executeRaw`SELECT set_config('app.current_school_id', ${schoolId}, true)`;
                return query(args);
              }

              return (basePrisma as any).$transaction(async (tx: any) => {
                await tx.$executeRaw`SELECT set_config('app.current_school_id', ${schoolId}, true)`;
                const modelKey = model.charAt(0).toLowerCase() + model.slice(1);
                const targetModel = tx[modelKey] ?? tx[model];
                return targetModel[operation](args);
              });
            },
          },
          async $queryRaw({ args, query }) {
            const schoolId = tc.getTenantId();
            if (!schoolId) {
              return query(args);
            }
            const isTransactionClient = typeof (basePrisma as any).$transaction !== "function";
            if (isTransactionClient) {
              await (basePrisma as any)
                .$executeRaw`SELECT set_config('app.current_school_id', ${schoolId}, true)`;
              return query(args);
            }
            return (basePrisma as any).$transaction(async (tx: any) => {
              await tx.$executeRaw`SELECT set_config('app.current_school_id', ${schoolId}, true)`;
              return tx.$queryRaw(args as any);
            });
          },
          async $executeRaw({ args, query }) {
            const schoolId = tc.getTenantId();
            if (!schoolId) {
              return query(args);
            }
            const isTransactionClient = typeof (basePrisma as any).$transaction !== "function";
            if (isTransactionClient) {
              await (basePrisma as any)
                .$executeRaw`SELECT set_config('app.current_school_id', ${schoolId}, true)`;
              return query(args);
            }
            return (basePrisma as any).$transaction(async (tx: any) => {
              await tx.$executeRaw`SELECT set_config('app.current_school_id', ${schoolId}, true)`;
              return tx.$executeRaw(args as any);
            });
          },
        },
      });
    }
    return this._tenantClient;
  }
}
