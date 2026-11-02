import { AsyncLocalStorage } from "node:async_hooks";
import { BadRequestException, Injectable } from "@nestjs/common";

export interface TenantContext {
  schoolId?: string;
  userId?: string;
  requestId?: string;
}

const NIL_UUID = "00000000-0000-0000-0000-000000000000";
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

@Injectable()
export class TenantContextService {
  private readonly storage = new AsyncLocalStorage<TenantContext>();

  /**
   * Validate that a given string is a valid non-nil RFC 4122/UUIDv7 UUID.
   */
  validateTenantId(schoolId: string): void {
    if (!schoolId || typeof schoolId !== "string") {
      throw new BadRequestException("Tenant ID is required");
    }
    const trimmed = schoolId.trim();
    if (trimmed === NIL_UUID) {
      throw new BadRequestException("Nil-UUID is not a valid tenant ID");
    }
    if (!UUID_REGEX.test(trimmed)) {
      throw new BadRequestException("Malformed tenant ID: must be a valid UUID");
    }
  }

  /**
   * Run an asynchronous function within a bound tenant context.
   */
  async run<T>(context: TenantContext, fn: () => Promise<T>): Promise<T> {
    if (context.schoolId) {
      this.validateTenantId(context.schoolId);
    }
    return this.storage.run(context, fn);
  }

  /**
   * Get the current active school/tenant ID, or undefined if no tenant is set.
   */
  getTenantId(): string | undefined {
    return this.storage.getStore()?.schoolId;
  }

  /**
   * Get the full tenant context store.
   */
  getContext(): TenantContext | undefined {
    return this.storage.getStore();
  }
}
