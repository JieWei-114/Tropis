import { Module } from '@nestjs/common';
import {
  PrometheusModule,
  makeCounterProvider,
  makeHistogramProvider,
} from '@willsoto/nestjs-prometheus';
import { MetricsController } from './metrics.controller';

@Module({
  imports: [
    PrometheusModule.register({
      path: '/metrics',
      controller: MetricsController,
      defaultMetrics: { enabled: true },
    }),
  ],
  providers: [
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
  ],
  exports: [PrometheusModule],
})
export class MetricsModule {}
