import { AppError } from '../../common/errors/app-error';
import type { TenantId } from '../../common/keyspace';
import {
  currentTenant,
  isGlobalScope,
  parseTenantId,
  runGlobal,
  runInTenant,
} from '../../common/tenant/tenant.context';

/**
 * Tenant scope for background jobs, shared by every jobs adapter.
 *
 * The enqueuer's scope (its tenant, or an explicit runGlobal) travels inside
 * the job data under JOB_TENANT_FIELD, next to the trace carrier, and every
 * attempt runs inside that scope again. There is no fallback: an enqueue from
 * an unscoped caller, or an attempt whose data carries no scope, fails with
 * TENANT_REQUIRED, so a job can never touch tenant data it was not given.
 */
export const JOB_TENANT_FIELD = '__tenant';

export type JobScope =
  | { readonly scope: 'tenant'; readonly tenantId: TenantId }
  | { readonly scope: 'global' };

function isRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    !Buffer.isBuffer(value)
  );
}

/** The caller's scope; TENANT_REQUIRED outside a tenant or global scope. */
export function captureJobScope(): JobScope {
  const tenantId = currentTenant();
  if (tenantId) return { scope: 'tenant', tenantId };
  if (isGlobalScope()) return { scope: 'global' };
  throw new AppError('TENANT_REQUIRED', {
    detail: 'A job must be enqueued inside a tenant or global scope',
  });
}

/** Job data with the scope attached; job data must be a plain object. */
export function attachJobScope<T>(data: T, scope: JobScope): T {
  if (!isRecord(data)) {
    throw new TypeError('Job data must be a plain object to carry its tenant');
  }
  return { ...data, [JOB_TENANT_FIELD]: scope } as T;
}

function parseScope(raw: unknown): JobScope | undefined {
  if (!isRecord(raw)) return undefined;
  if (raw.scope === 'global') return { scope: 'global' };
  if (raw.scope === 'tenant') {
    return { scope: 'tenant', tenantId: parseTenantId(raw.tenantId) };
  }
  return undefined;
}

export function detachJobScope(data: unknown): {
  data: unknown;
  scope: JobScope | undefined;
} {
  if (!isRecord(data) || !(JOB_TENANT_FIELD in data)) {
    return { data, scope: undefined };
  }
  const { [JOB_TENANT_FIELD]: raw, ...rest } = data;
  return { data: rest, scope: parseScope(raw) };
}

/** Runs one attempt inside its scope; TENANT_REQUIRED when it has none. */
export function runInJobScope<R>(
  scope: JobScope | undefined,
  fn: () => Promise<R>,
): Promise<R> {
  if (!scope) {
    return Promise.reject(
      new AppError('TENANT_REQUIRED', {
        detail: 'The job carries no tenant scope',
      }),
    );
  }
  return scope.scope === 'tenant'
    ? runInTenant(scope.tenantId, fn)
    : runGlobal(fn);
}
