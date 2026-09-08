import { Injectable } from '@nestjs/common';
import { AsyncLocalStorage } from 'async_hooks';
import { DEFAULT_TENANT } from '../../modules/user/schemas/user.schema';

interface TenantStore {
  tenantId: string;
}

/**
 * Ambient tenant context for the current request/RPC, backed by
 * AsyncLocalStorage.
 *
 * Must stay a singleton. `Scope.REQUEST` would make every consumer
 * request-scoped too (UserService, UserRepository, the CQRS handlers), so no
 * singleton can inject it. As a singleton over AsyncLocalStorage any service
 * can read the current tenant without threading it through every signature and
 * without changing DI scopes. Callers at the transport boundary must wrap the
 * continuation in `run()`; outside one, reads fall back to DEFAULT_TENANT.
 *
 * Bound at the transport boundary by GrpcTenantInterceptor, which is a global
 * interceptor and so covers both gRPC calls and HTTP requests (for HTTP it
 * reads the tenant TenantMiddleware resolved onto the request).
 */
@Injectable()
export class TenantContext {
  private readonly als = new AsyncLocalStorage<TenantStore>();

  /** Runs `fn` with `tenantId` visible to everything it awaits. */
  run<T>(tenantId: string, fn: () => T): T {
    return this.als.run({ tenantId: tenantId || DEFAULT_TENANT }, fn);
  }

  /**
   * Current tenant, or DEFAULT_TENANT outside a request (cron jobs, message
   * consumers, startup). Those paths must pass a tenant explicitly when they
   * act on tenant-scoped data.
   */
  get tenantId(): string {
    return this.als.getStore()?.tenantId ?? DEFAULT_TENANT;
  }
}
