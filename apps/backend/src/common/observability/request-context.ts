import { AsyncLocalStorage } from 'async_hooks';

/**
 * What every log record, error body and audit entry needs to know about the
 * unit of work in progress (an HTTP request, an RPC, a consumed message),
 * held in AsyncLocalStorage so no call signature has to carry it.
 */
export interface RequestContext {
  /** W3C trace id; also the request id echoed in `x-request-id`. */
  traceId: string;
  /** Tenant, once a transport boundary has resolved it. */
  tenantId?: string;
  /** A caller-supplied `x-request-id`, kept only for correlation. */
  clientRequestId?: string;
}

const store = new AsyncLocalStorage<RequestContext>();

/** Placeholder returned by getRequestId() outside any unit of work. */
export const NO_REQUEST_CONTEXT = 'no-request-context';

export function runWithRequestContext<T>(ctx: RequestContext, fn: () => T): T {
  return store.run({ ...ctx }, fn);
}

export function currentRequestContext(): RequestContext | undefined {
  return store.getStore();
}

/** Records the tenant on the current context (no-op outside one). */
export function setRequestTenant(tenantId: string | undefined): void {
  const ctx = store.getStore();
  if (ctx && tenantId) ctx.tenantId = tenantId;
}
