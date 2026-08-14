import { Injectable, Scope } from '@nestjs/common';
import { DEFAULT_TENANT } from '../../modules/user/schemas/user.schema';

/**
 * Request-scoped tenant context.
 *
 * Populated by TenantMiddleware from either:
 *   1. JWT payload field `tenantId`
 *   2. X-Tenant-ID request header (used by machine clients that authenticate separately)
 *
 * Inject this anywhere in a request to get the current tenant without
 * threading tenantId through every method signature.
 */
@Injectable({ scope: Scope.REQUEST })
export class TenantContext {
  private _tenantId: string = DEFAULT_TENANT;

  set(tenantId: string): void {
    this._tenantId = tenantId || DEFAULT_TENANT;
  }

  get tenantId(): string {
    return this._tenantId;
  }
}
