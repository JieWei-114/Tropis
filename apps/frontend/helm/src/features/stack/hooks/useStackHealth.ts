/**
 * STACK FEATURE — polls the backend /api/health endpoint every 10s and
 * exposes per-service up/down state for the health cards.
 */
import { useEffect, useState, useCallback, useRef } from 'react';
import { env } from '../../../lib/env';

const API_BASE = `${env.VITE_API_BASE_URL}/api`;

interface ServiceStatus {
  status: 'up' | 'down' | 'unknown';
}

interface HealthResponse {
  status: 'ok' | 'error';
  info?: Record<string, ServiceStatus>;
  error?: Record<string, ServiceStatus>;
}

export interface ServiceState {
  name: string;
  /**
   * 'unreachable' means WE could not reach the backend — distinct from 'down',
   * which is the backend telling us a dependency is failing. The two must stay
   * separate, or a dropped connection on this end reads as a cluster-wide
   * outage.
   */
  status: 'up' | 'down' | 'loading' | 'unreachable';
}

/**
 * `backend` is not a key in the health payload — it is derived: if the probe
 * answered at all, the backend is up, and if it did not, it is unreachable.
 * Deriving it is what lets the Stack page report a status for the service that
 * serves the page itself.
 */
const DERIVED_BACKEND = 'backend';

const SERVICE_ORDER = [
  DERIVED_BACKEND,
  'mongo',
  'redis',
  'postgres',
  'elasticsearch',
  'clickhouse',
  'pulsar',
  'minio',
  'opa',
  'temporal',
  'aerospike',
  'pgvector',
];

export function useStackHealth() {
  const [services, setServices] = useState<ServiceState[]>(
    SERVICE_ORDER.map((name) => ({ name, status: 'loading' })),
  );
  const [lastChecked, setLastChecked] = useState<Date | null>(null);
  const [checking, setChecking] = useState(false);

  // Guards against overlapping probes: the 10s interval could otherwise stack
  // slow requests, and the last one to resolve would clobber the newest state.
  const inFlight = useRef(false);

  const checkHealth = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setChecking(true);
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 8000);
      let res: Response;
      try {
        res = await fetch(`${API_BASE}/health`, { signal: controller.signal });
      } finally {
        clearTimeout(timeout);
      }
      // A non-2xx health response still carries a body describing each service;
      // only a transport failure means "unreachable".
      const body = (await res.json()) as HealthResponse;

      const all = { ...(body.info ?? {}), ...(body.error ?? {}) };

      setServices(
        SERVICE_ORDER.map((name) => {
          if (name === DERIVED_BACKEND) return { name, status: 'up' as const };
          // pgvector is a Postgres extension — it has no separate probe, so it
          // reports whatever Postgres reports.
          const key = name === 'pgvector' ? 'postgres' : name;
          return {
            name,
            status: all[key]
              ? all[key].status === 'up'
                ? ('up' as const)
                : ('down' as const)
              : ('down' as const),
          };
        }),
      );
      setLastChecked(new Date());
    } catch {
      // Could not reach the backend at all — do not claim every dependency is down.
      setServices((prev) => prev.map((s) => ({ ...s, status: 'unreachable' })));
    } finally {
      inFlight.current = false;
      setChecking(false);
    }
  }, []);

  useEffect(() => {
    void checkHealth();
    const interval = setInterval(() => {
      void checkHealth();
    }, 10_000);
    return () => clearInterval(interval);
  }, [checkHealth]);

  return { services, lastChecked, checking, checkHealth };
}
