import { Injectable, type Type } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { HealthCheckError, type HealthIndicatorResult } from '@nestjs/terminus';
import { CacheHealthIndicator } from '../../../infrastructure/cache/cache.health';
import { DedupHealthIndicator } from '../../../infrastructure/dedup/dedup.health';
import { DocumentsHealthIndicator } from '../../../infrastructure/documents/documents.health';
import { GraphHealthIndicator } from '../../../infrastructure/graph/graph.health';
import { JobsHealthIndicator } from '../../../infrastructure/jobs/jobs.health';
import { KvHealthIndicator } from '../../../infrastructure/kv/kv.health';
import { LockHealthIndicator } from '../../../infrastructure/lock/lock.health';
import { MailHealthIndicator } from '../../../infrastructure/mail/mail.health';
import { ConsumersHealthIndicator } from '../../../infrastructure/messaging/consumers.health';
import { MessagingHealthIndicator } from '../../../infrastructure/messaging/messaging.health';
import { ObjectsHealthIndicator } from '../../../infrastructure/objects/objects.health';
import { OlapHealthIndicator } from '../../../infrastructure/olap/olap.health';
import { RealtimeHealthIndicator } from '../../../infrastructure/realtime/realtime.health';
import { PolicyHealthIndicator } from '../../../infrastructure/policy/policy.health';
import { RateLimitHealthIndicator } from '../../../infrastructure/ratelimit/ratelimit.health';
import { RelationalHealthIndicator } from '../../../infrastructure/relational/relational.health';
import { SearchHealthIndicator } from '../../../infrastructure/search/search.health';
import { SecretsHealthIndicator } from '../../../infrastructure/secrets/secrets.health';
import { SigningHealthIndicator } from '../../../infrastructure/signing/signing.health';
import { VectorHealthIndicator } from '../../../infrastructure/vector/vector.health';
import { WorkflowHealthIndicator } from '../../../infrastructure/workflow/workflow.health';
import {
  CHEAP_PROBES,
  PROBE_CACHE_MS,
  PROBE_KEYS,
  PROBE_TIMEOUT_MS,
  type ProbeKey,
  type ProbeScope,
} from '../health.probes';

interface Indicator {
  isHealthy(key?: string): Promise<HealthIndicatorResult>;
}

const INDICATORS: Record<ProbeKey, Type<Indicator>> = {
  documents: DocumentsHealthIndicator,
  relational: RelationalHealthIndicator,
  vector: VectorHealthIndicator,
  search: SearchHealthIndicator,
  olap: OlapHealthIndicator,
  objects: ObjectsHealthIndicator,
  graph: GraphHealthIndicator,
  cache: CacheHealthIndicator,
  kv: KvHealthIndicator,
  lock: LockHealthIndicator,
  ratelimit: RateLimitHealthIndicator,
  dedup: DedupHealthIndicator,
  messaging: MessagingHealthIndicator,
  consumers: ConsumersHealthIndicator,
  jobs: JobsHealthIndicator,
  workflow: WorkflowHealthIndicator,
  realtime: RealtimeHealthIndicator,
  secrets: SecretsHealthIndicator,
  policy: PolicyHealthIndicator,
  mail: MailHealthIndicator,
  signing: SigningHealthIndicator,
};

type ProbeResult = HealthIndicatorResult[string];

/** Terminus-shaped report plus the optional probes that are down. */
export interface HealthReport {
  /** `error` when a required probe is down. */
  status: 'ok' | 'error';
  info: Record<string, ProbeResult>;
  error: Record<string, ProbeResult>;
  details: Record<string, ProbeResult>;
  /** Optional probes that are down; they do not fail readiness. */
  degraded: string[];
}

/** Probe messages can name hosts and credentials; callers get statuses only. */
export function withoutMessages(report: HealthReport): HealthReport {
  const strip = (entries: Record<string, ProbeResult> = {}) =>
    Object.fromEntries(
      Object.entries(entries).map(([key, { message: _message, ...rest }]) => [
        key,
        rest,
      ]),
    ) as Record<string, ProbeResult>;
  return {
    ...report,
    info: strip(report.info),
    error: strip(report.error),
    details: strip(report.details),
  };
}

/**
 * Runs the dependency probes: one per capability module the process loaded
 * (looked up across modules); a capability the role does not load is left
 * out, and a required one it does not load is not checked. A capability
 * whose adapter is `disabled` reports `up` with `disabled: true`.
 *
 * A `readiness` report runs only the required probes and the cheap
 * optional ones (CHEAP_PROBES); a `full` report runs every probe. Each
 * probe's result is shared by every caller for PROBE_CACHE_MS
 * (single-flight per probe), so /readyz polling and /api/health traffic
 * cost at most one probe per dependency per window.
 */
@Injectable()
export class HealthProbesService {
  private readonly cached = new Map<
    ProbeKey,
    { at: number; result: ProbeResult }
  >();
  private readonly inflight = new Map<ProbeKey, Promise<ProbeResult>>();

  constructor(private readonly moduleRef: ModuleRef) {}

  /** Report over the probes of `scope`; `required` decides the status. */
  async report(
    required: readonly ProbeKey[],
    scope: ProbeScope = 'full',
  ): Promise<HealthReport> {
    const keys =
      scope === 'full'
        ? PROBE_KEYS
        : PROBE_KEYS.filter(
            (k) => required.includes(k) || CHEAP_PROBES.includes(k),
          );
    const results = await this.results(keys);
    const report: HealthReport = {
      status: 'ok',
      info: {},
      error: {},
      details: {},
      degraded: [],
    };
    for (const [key, result] of results) {
      report.details[key] = result;
      if (result.status === 'up') {
        report.info[key] = result;
        continue;
      }
      report.error[key] = result;
      if (required.includes(key)) report.status = 'error';
      else report.degraded.push(key);
    }
    return report;
  }

  private async results(
    keys: readonly ProbeKey[],
  ): Promise<Map<ProbeKey, ProbeResult>> {
    const entries = await Promise.all(
      keys.map(async (key) => {
        const indicator = this.indicator(key);
        if (!indicator) return null;
        return [key, await this.result(key, indicator)] as const;
      }),
    );
    return new Map(
      entries.filter((e): e is readonly [ProbeKey, ProbeResult] => !!e),
    );
  }

  private result(key: ProbeKey, indicator: Indicator): Promise<ProbeResult> {
    const cached = this.cached.get(key);
    if (cached && Date.now() - cached.at < PROBE_CACHE_MS) {
      return Promise.resolve(cached.result);
    }
    let running = this.inflight.get(key);
    if (!running) {
      running = probe(indicator, key)
        .then((result) => {
          this.cached.set(key, { at: Date.now(), result });
          return result;
        })
        .finally(() => this.inflight.delete(key));
      this.inflight.set(key, running);
    }
    return running;
  }

  private indicator(key: ProbeKey): Indicator | null {
    try {
      return this.moduleRef.get(INDICATORS[key], { strict: false });
    } catch {
      return null;
    }
  }
}
async function probe(
  indicator: Indicator,
  key: ProbeKey,
): Promise<ProbeResult> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`probe timed out after ${PROBE_TIMEOUT_MS}ms`)),
      PROBE_TIMEOUT_MS,
    );
  });
  try {
    const result = await Promise.race([indicator.isHealthy(key), timeout]);
    return result[key] ?? { status: 'up' };
  } catch (err) {
    if (err instanceof HealthCheckError) {
      const causes = err.causes as HealthIndicatorResult | undefined;
      if (causes?.[key]) return causes[key];
    }
    return {
      status: 'down',
      message: err instanceof Error ? err.message : String(err),
    };
  } finally {
    clearTimeout(timer);
  }
}
