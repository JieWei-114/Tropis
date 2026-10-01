import { Counter, Histogram, register, type Registry } from 'prom-client';

/**
 * RED metrics for every HTTP route and RPC method, recorded automatically by
 * HttpMetricsMiddleware and the RPC metrics interceptor.
 *
 * Naming: `tropis_<module>_<name>_<unit>`, with `_total` for counters and a
 * base unit suffix (`_seconds`, `_bytes`) otherwise. Labels are bounded
 * sets only: a route template, never a raw path; a status class, never a
 * user, tenant or email.
 *
 * Instruments live on prom-client's default registry, which the ops server
 * serves at :OPS_PORT/metrics (modules/health/ops-server.ts).
 */
export const HTTP_REQUESTS_METRIC = 'tropis_http_server_requests_total';
export const HTTP_DURATION_METRIC = 'tropis_http_server_duration_seconds';
export const RPC_REQUESTS_METRIC = 'tropis_rpc_server_requests_total';
export const RPC_DURATION_METRIC = 'tropis_rpc_server_duration_seconds';

const DURATION_BUCKETS = [
  0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10,
];

type HttpLabel = 'method' | 'route' | 'status_class';
type RpcLabel = 'service' | 'method' | 'code';

/** The counter `name` on `registry`, created on first use. */
export function counter<L extends string>(
  name: string,
  help: string,
  labelNames: readonly L[],
  registry: Registry = register,
): Counter<L> {
  return (
    (registry.getSingleMetric(name) as Counter<L> | undefined) ??
    new Counter<L>({ name, help, labelNames, registers: [registry] })
  );
}

function histogram<L extends string>(
  name: string,
  help: string,
  labelNames: readonly L[],
  registry: Registry,
): Histogram<L> {
  return (
    (registry.getSingleMetric(name) as Histogram<L> | undefined) ??
    new Histogram<L>({
      name,
      help,
      labelNames,
      buckets: DURATION_BUCKETS,
      registers: [registry],
    })
  );
}

export interface RedMetrics {
  httpRequests: Counter<HttpLabel>;
  httpDuration: Histogram<HttpLabel>;
  rpcRequests: Counter<RpcLabel>;
  rpcDuration: Histogram<RpcLabel>;
}

/** The RED instruments on `registry`, created on first use. */
export function redMetrics(registry: Registry = register): RedMetrics {
  return {
    httpRequests: counter(
      HTTP_REQUESTS_METRIC,
      'HTTP requests served, by route template and status class',
      ['method', 'route', 'status_class'],
      registry,
    ),
    httpDuration: histogram(
      HTTP_DURATION_METRIC,
      'HTTP request duration in seconds, by route template and status class',
      ['method', 'route', 'status_class'],
      registry,
    ),
    rpcRequests: counter(
      RPC_REQUESTS_METRIC,
      'RPC calls served, by service, method and Connect code',
      ['service', 'method', 'code'],
      registry,
    ),
    rpcDuration: histogram(
      RPC_DURATION_METRIC,
      'RPC call duration in seconds, by service, method and Connect code',
      ['service', 'method', 'code'],
      registry,
    ),
  };
}

export function statusClass(status: number): string {
  if (status >= 100 && status < 600) return `${Math.floor(status / 100)}xx`;
  return 'unknown';
}

/** Methods outside this set are reported as `OTHER` (bounded label). */
const HTTP_METHODS = new Set([
  'GET',
  'HEAD',
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
  'OPTIONS',
]);

export function methodLabel(method: string | undefined): string {
  const m = (method ?? '').toUpperCase();
  return HTTP_METHODS.has(m) ? m : 'OTHER';
}
