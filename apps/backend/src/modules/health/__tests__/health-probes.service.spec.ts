import type { ModuleRef } from '@nestjs/core';
import { HealthCheckError } from '@nestjs/terminus';
import { GraphHealthIndicator } from '../../../infrastructure/graph/graph.health';
import { MessagingHealthIndicator } from '../../../infrastructure/messaging/messaging.health';
import {
  CHEAP_PROBES,
  PROBE_CACHE_MS,
  PROBE_KEYS,
  PROBE_TIMEOUT_MS,
  READINESS_PROBES,
  requiredProbes,
} from '../health.probes';
import { HealthProbesService } from '../services/health-probes.service';

type Behaviour = 'up' | 'down' | 'hang';

function service(
  behaviour: Partial<Record<string, Behaviour>>,
  absent: unknown[] = [],
) {
  const calls: string[] = [];
  const moduleRef = {
    get: jest.fn((type: unknown) => {
      if (absent.includes(type)) throw new Error('not provided');
      return {
        isHealthy: (key: string) => {
          calls.push(key);
          switch (behaviour[key] ?? 'up') {
            case 'down':
              return Promise.reject(
                new HealthCheckError(`${key} down`, {
                  [key]: { status: 'down', message: 'refused' },
                }),
              );
            case 'hang':
              return new Promise(() => undefined);
            default:
              return Promise.resolve({ [key]: { status: 'up' } });
          }
        },
      };
    }),
  };
  return {
    probes: new HealthProbesService(moduleRef as unknown as ModuleRef),
    calls,
  };
}

describe('HealthProbesService', () => {
  afterEach(() => jest.useRealTimers());

  it('keeps optional capabilities out of every role readiness', () => {
    const optional = [
      'olap',
      'search',
      'objects',
      'graph',
      'signing',
      'workflow',
      'relational',
      'vector',
    ];
    for (const keys of Object.values(READINESS_PROBES)) {
      expect(keys.filter((k) => optional.includes(k))).toEqual([]);
    }
    expect(requiredProbes('public')).toEqual(
      expect.arrayContaining([
        'documents',
        'cache',
        'kv',
        'policy',
        'messaging',
      ]),
    );
    expect(requiredProbes('unknown')).toBe(READINESS_PROBES.all);
  });

  it('reports an optional dependency outage as degraded, not an error', async () => {
    const { probes } = service({ olap: 'down', workflow: 'down' });
    const report = await probes.report(READINESS_PROBES.public);
    expect(report.status).toBe('ok');
    expect(report.degraded.sort()).toEqual(['olap', 'workflow']);
    expect(report.error.olap).toEqual({
      status: 'down',
      message: 'refused',
    });
    expect(report.info.documents).toEqual({ status: 'up' });
  });

  it('fails when a required dependency is down', async () => {
    const { probes } = service({ documents: 'down' });
    const report = await probes.report(READINESS_PROBES.public);
    expect(report.status).toBe('error');
    expect(report.degraded).toEqual([]);
  });

  it('leaves out capabilities this process does not load', async () => {
    const { probes, calls } = service({}, [GraphHealthIndicator]);
    const report = await probes.report(READINESS_PROBES.public);
    expect(report.status).toBe('ok');
    expect(calls).not.toContain('graph');
    expect(report.details.graph).toBeUndefined();
  });

  it('does not check a required capability the role does not load', async () => {
    const { probes } = service({}, [MessagingHealthIndicator]);
    const report = await probes.report(READINESS_PROBES.public);
    expect(report.status).toBe('ok');
    expect(report.details.messaging).toBeUndefined();
  });

  it('shares one probe run between concurrent and recent callers', async () => {
    jest.useFakeTimers({ now: 0 });
    const { probes, calls } = service({});
    await Promise.all([
      probes.report(READINESS_PROBES.public),
      probes.report(READINESS_PROBES.worker),
    ]);
    await probes.report(READINESS_PROBES.public);
    expect(calls).toHaveLength(PROBE_KEYS.length);

    jest.setSystemTime(PROBE_CACHE_MS + 1);
    await probes.report(READINESS_PROBES.public);
    expect(calls).toHaveLength(PROBE_KEYS.length * 2);
  });

  it('counts a probe that does not answer as down', async () => {
    jest.useFakeTimers();
    const { probes } = service({ search: 'hang' });
    const pending = probes.report(READINESS_PROBES.public);
    await jest.advanceTimersByTimeAsync(PROBE_TIMEOUT_MS + 1);
    const report = await pending;
    expect(report.status).toBe('ok');
    expect(report.degraded).toEqual(['search']);
  });

  it('runs only the required and the cheap probes for readiness', async () => {
    const { probes, calls } = service({ mail: 'down' });
    const report = await probes.report(READINESS_PROBES.worker, 'readiness');
    expect(calls.sort()).toEqual(
      [...new Set([...READINESS_PROBES.worker, ...CHEAP_PROBES])].sort(),
    );
    expect(calls).not.toContain('mail');
    expect(report.status).toBe('ok');
  });

  it('requires the worker consumers to be running', () => {
    expect(requiredProbes('worker')).toContain('consumers');
    expect(requiredProbes('public')).not.toContain('consumers');
  });
});
