import { Module } from '@nestjs/common';
import {
  PrometheusModule,
  getToken,
  makeCounterProvider,
  makeGaugeProvider,
  makeHistogramProvider,
} from '@willsoto/nestjs-prometheus';
import { MetricsController } from './metrics.controller';
import {
  OUTBOX_RELAY_LAST_POLL_METRIC,
  OUTBOX_ROWS_METRIC,
  TRACKING_DUPLICATES_METRIC,
} from './metrics.constants';

// One prom-client registry for the whole app: every metric is declared here and
// injected with @InjectMetric(...) where it is recorded.
const metricProviders = [
  makeCounterProvider({
    name: 'http_requests_total',
    help: 'Total number of HTTP requests',
    labelNames: ['method', 'route', 'status_code'],
  }),
  makeHistogramProvider({
    name: 'http_request_duration_seconds',
    help: 'HTTP request duration in seconds',
    labelNames: ['method', 'route', 'status_code'],
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
  }),
  makeCounterProvider({
    name: 'queue_jobs_total',
    help: 'Total BullMQ jobs enqueued',
    labelNames: ['queue', 'job_name'],
  }),
  // Reliability metrics. Refreshed from the outbox relay's existing polls, so
  // they add no request-path or extra scheduled database work.
  makeGaugeProvider({
    name: OUTBOX_ROWS_METRIC,
    help: 'Outbox rows currently in each non-terminal-success status',
    labelNames: ['status'],
  }),
  makeGaugeProvider({
    name: OUTBOX_RELAY_LAST_POLL_METRIC,
    help: 'Unix timestamp of the last outbox relay poll that held the lock',
  }),
  makeCounterProvider({
    name: TRACKING_DUPLICATES_METRIC,
    help: 'Tracking events dropped by the ingest dedup claim',
  }),
];

@Module({
  imports: [
    PrometheusModule.register({
      path: '/metrics',
      controller: MetricsController,
      defaultMetrics: { enabled: true },
    }),
  ],
  providers: metricProviders,
  exports: [
    PrometheusModule,
    getToken(OUTBOX_ROWS_METRIC),
    getToken(OUTBOX_RELAY_LAST_POLL_METRIC),
    getToken(TRACKING_DUPLICATES_METRIC),
  ],
})
export class MetricsModule {}
