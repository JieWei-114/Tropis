import { Injectable } from '@nestjs/common';
import { AsyncLocalStorage } from 'async_hooks';
import { AppError } from '../errors/app-error';
import { isTenantId, type TenantId } from '../keyspace';

type TenantScope =
  | { readonly kind: 'tenant'; readonly tenantId: TenantId }
  | { readonly kind: 'global' };

const storage = new AsyncLocalStorage<TenantScope>();

/** Validates a raw tenant id from a transport, throwing TENANT_INVALID. */
export function parseTenantId(raw: unknown): TenantId {
  if (!isTenantId(raw)) {
    throw new AppError('TENANT_INVALID', {
      detail: 'Tenant ids are 1-128 characters of [A-Za-z0-9_.-]',
    });
  }
  return raw;
}

/** Runs `fn` scoped to one tenant. */
export function runInTenant<T>(tenantId: TenantId, fn: () => T): T {
  return storage.run({ kind: 'tenant', tenantId: parseTenantId(tenantId) }, fn);
}

/**
 * Runs `fn` as an explicitly global operation. Reading the tenant inside it
 * throws, so tenant-scoped data is unreachable from a global scope.
 */
export function runGlobal<T>(fn: () => T): T {
  return storage.run({ kind: 'global' }, fn);
}

/** The current tenant, or undefined outside a tenant scope. */
export function currentTenant(): TenantId | undefined {
  const scope = storage.getStore();
  return scope?.kind === 'tenant' ? scope.tenantId : undefined;
}

/** Whether the caller runs inside an explicit runGlobal() scope. */
export function isGlobalScope(): boolean {
  return storage.getStore()?.kind === 'global';
}

/** The current tenant; throws TENANT_REQUIRED outside a tenant scope. */
export function requireTenant(): TenantId {
  const tenantId = currentTenant();
  if (!tenantId) throw new AppError('TENANT_REQUIRED');
  return tenantId;
}

/**
 * The tenant of the unit of work in progress (HTTP request, RPC, consumed
 * message), held in AsyncLocalStorage so singletons can read it without
 * request-scoped DI. The transport boundary binds it; there is no fallback
 * tenant, so tenant-scoped code outside a scope fails with TENANT_REQUIRED.
 */
@Injectable()
export class TenantContext {
  run<T>(tenantId: TenantId, fn: () => T): T {
    return runInTenant(tenantId, fn);
  }

  runGlobal<T>(fn: () => T): T {
    return runGlobal(fn);
  }

  /** The current tenant; throws TENANT_REQUIRED outside a tenant scope. */
  get tenant(): TenantId {
    return requireTenant();
  }

  /** Same as `tenant`. */
  get tenantId(): TenantId {
    return requireTenant();
  }

  /** The current tenant, or undefined outside a tenant scope. */
  get current(): TenantId | undefined {
    return currentTenant();
  }
}
