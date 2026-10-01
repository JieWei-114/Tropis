/**
 * One probe per capability, named after the capability, never the
 * technology: the adapter in use is reported next to the status. A
 * capability a role does not load is not probed.
 */
export const PROBE_KEYS = [
  'documents',
  'relational',
  'vector',
  'search',
  'olap',
  'objects',
  'graph',
  'cache',
  'kv',
  'lock',
  'ratelimit',
  'dedup',
  'messaging',
  'consumers',
  'jobs',
  'workflow',
  'realtime',
  'secrets',
  'policy',
  'mail',
  'signing',
] as const;

export type ProbeKey = (typeof PROBE_KEYS)[number];

export type ServiceRole = 'all' | 'public' | 'private' | 'worker' | 'scheduler';

/**
 * What each role cannot serve without: /readyz on the ops port is 503 while
 * any of these is down. Every other probe is optional: a failure is reported
 * as degraded in /readyz and /api/health but keeps the role in rotation, so
 * an outage of a store only some requests touch does not take the role out.
 * A required capability the role does not load (its modules do not use it)
 * is not checked.
 */
export const READINESS_PROBES: Readonly<
  Record<ServiceRole, readonly ProbeKey[]>
> = {
  all: [
    'documents',
    'cache',
    'kv',
    'ratelimit',
    'lock',
    'dedup',
    'policy',
    'messaging',
    'consumers',
    'jobs',
  ],
  public: ['documents', 'cache', 'kv', 'ratelimit', 'policy', 'messaging'],
  private: ['documents', 'cache', 'kv'],
  worker: ['documents', 'lock', 'dedup', 'messaging', 'consumers', 'jobs'],
  scheduler: ['jobs'],
};

/**
 * Optional probes that cost no network round trip, so /readyz runs them
 * next to the required ones; every other optional probe runs only for the
 * full report (/api/health).
 */
export const CHEAP_PROBES: readonly ProbeKey[] = ['consumers'];

/** Which probes a report runs: the role's readiness set, or every probe. */
export type ProbeScope = 'readiness' | 'full';

/** How long one probe run is reused, so polling cannot multiply probe load. */
export const PROBE_CACHE_MS = 3_000;

/** A probe that has not answered by then counts as down. */
export const PROBE_TIMEOUT_MS = 3_000;

/** The required probes of the role this process runs. */
export function requiredProbes(role: string): readonly ProbeKey[] {
  return READINESS_PROBES[role as ServiceRole] ?? READINESS_PROBES.all;
}
