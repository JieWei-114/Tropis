/**
 * STACK FEATURE — polls the backend /api/health endpoint (through the SDK)
 * every 10s and exposes per-service up/down state for the health cards.
 */
import { useEffect, useState, useCallback, useRef } from 'react';
import { getHealth, type HealthCheck } from '../../../lib/api';

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

/**
 * The health payload names capabilities, not technologies: each technology
 * on the page reads the capability it backs, and must be that capability's
 * selected adapter (a broker swapped for Kafka leaves the Pulsar card down).
 * A failing server answers a problem whose `checks[]` names no adapters;
 * there a capability that is up counts as up whatever backs it.
 */
const SERVICE_PROBES: Record<string, { probe: string; adapter?: string }> = {
  mongo: { probe: 'documents' },
  redis: { probe: 'cache', adapter: 'redis' },
  postgres: { probe: 'relational' },
  elasticsearch: { probe: 'search', adapter: 'elasticsearch' },
  clickhouse: { probe: 'olap', adapter: 'clickhouse' },
  pulsar: { probe: 'messaging', adapter: 'pulsar' },
  minio: { probe: 'objects', adapter: 'minio' },
  opa: { probe: 'policy' },
  temporal: { probe: 'workflow', adapter: 'temporal' },
  aerospike: { probe: 'kv', adapter: 'aerospike' },
  pgvector: { probe: 'vector', adapter: 'pgvector' },
};

const SERVICE_ORDER = [DERIVED_BACKEND, ...Object.keys(SERVICE_PROBES)];

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
      const health = await getHealth();
      const byName = new Map<string, HealthCheck>(
        health.checks.map((c) => [c.name, c]),
      );

      setServices(
        SERVICE_ORDER.map((name) => {
          if (name === DERIVED_BACKEND) return { name, status: 'up' as const };
          const { probe, adapter } = SERVICE_PROBES[name];
          const check = byName.get(probe);
          const up =
            check?.status === 'up' &&
            !check.disabled &&
            (adapter === undefined ||
              check.adapter === undefined ||
              check.adapter === adapter);
          return { name, status: up ? ('up' as const) : ('down' as const) };
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
