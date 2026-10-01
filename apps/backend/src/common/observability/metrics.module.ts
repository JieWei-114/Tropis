import { Module } from '@nestjs/common';
import { collectDefaultMetrics, register } from 'prom-client';

const DEFAULT_METRICS = Symbol('DEFAULT_METRICS');

/**
 * The process metrics registry (prom-client's default one), served by the
 * ops server on OPS_PORT, never on the public HTTP port. It holds the
 * process metrics; the HTTP and RPC RED metrics are recorded by the
 * transports (metrics.ts), and every other metric is declared by the module
 * that records it, as a provider of that module.
 *
 * Naming: tropis_<module>_<name>_<unit>, `_total` for counters, a base-unit
 * suffix otherwise; labels are bounded sets only (never a user, tenant,
 * email or raw path).
 */
@Module({
  providers: [
    {
      provide: DEFAULT_METRICS,
      useFactory: () => {
        if (!register.getSingleMetric('process_cpu_user_seconds_total')) {
          collectDefaultMetrics();
        }
        return true;
      },
    },
  ],
})
export class MetricsModule {}
