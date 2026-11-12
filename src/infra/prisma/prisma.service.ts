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
      const activeTenantId = this.tenantContext.getTenantId();
      if (activeTenantId && activeTenantId !== schoolId && !this.tenantContext.isPlatformScope()) {
        throw new Error(
          `Cross-tenant execution forbidden: active request tenant ${activeTenantId} does not match target tenant ${schoolId}. Platform operations must use withPlatformTenant.`,
        );
      }
    }
    return this.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.current_school_id', ${schoolId}, true)`;
      return fn(tx);
    });
  }

  /**
   * Cross-tenant execution wrapper exclusively for platform operations.
   * Enforces that the execution holds active platform scope,
   * sets the target tenant context, delegates to withTenant within a transaction,
   * and writes a platform audit log entry.
   * Closes BACKLOG item 8 for platform use as the sole authorized cross-tenant caller of withTenant.
   */
  async withPlatformTenant<T>(
    targetSchoolId: string,
    op: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    if (this.tenantContext) {
      this.tenantContext.validateTenantId(targetSchoolId);
      if (!this.tenantContext.isPlatformScope()) {
        throw new Error("Cross-tenant execution requires active platform administrative scope.");
      }
    }

    const store = this.tenantContext?.getContext();
    const actorUserId = store?.userId || "00000000-0000-0000-0000-000000000000";

    return this.withTenant(targetSchoolId, async (tx) => {
      const result = await op(tx);

      // Write platform audit log entry (platform_audit_logs is append-only, progresseye_app has INSERT only)
      await tx.$executeRaw`
        INSERT INTO "platform_audit_logs" (
          "id",
          "actor_user_id",
          "action",
          "resource",
          "resource_id",
          "payload",
          "client_ip_hash",
          "user_agent",
          "created_at"
        ) VALUES (
          gen_random_uuid(),
          ${actorUserId}::uuid,
          'PLATFORM_CROSS_TENANT_OPERATION',
          'school',
          ${targetSchoolId},
          ${JSON.stringify({ action: "PLATFORM_CROSS_TENANT_OPERATION", targetSchoolId, actorUserId })}::jsonb,
          COALESCE(current_setting('app.client_ip_hash', true), 'internal'),
          COALESCE(current_setting('app.user_agent', true), 'internal-service'),
          CURRENT_TIMESTAMP(3)
        )
      `;
      return result;
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
