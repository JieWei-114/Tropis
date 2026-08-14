/**
 * STACK FEATURE — polls the backend /api/health endpoint every 10s and
 * exposes per-service up/down state for the health cards.
 */
import { useEffect, useState, useCallback } from 'react';
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
  status: 'up' | 'down' | 'loading';
}

export const SERVICE_ORDER = [
  'mongo',
  'redis',
  'postgres',
  'elasticsearch',
  'clickhouse',
  'pulsar',
];

export function useStackHealth() {
  const [services, setServices] = useState<ServiceState[]>(
    SERVICE_ORDER.map((name) => ({ name, status: 'loading' })),
  );
  const [lastChecked, setLastChecked] = useState<Date | null>(null);
  const [checking, setChecking] = useState(false);

  const checkHealth = useCallback(async () => {
    setChecking(true);
    try {
      const res = await fetch(`${API_BASE}/health`);
      const body = (await res.json()) as HealthResponse;

      const all = { ...(body.info ?? {}), ...(body.error ?? {}) };

      setServices(
        SERVICE_ORDER.map((name) => ({
          name,
          status: all[name]
            ? all[name].status === 'up'
              ? 'up'
              : 'down'
            : 'down',
        })),
      );
      setLastChecked(new Date());
    } catch {
      setServices((prev) => prev.map((s) => ({ ...s, status: 'down' })));
    } finally {
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
