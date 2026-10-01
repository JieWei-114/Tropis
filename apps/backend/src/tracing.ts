import { NodeSDK } from '@opentelemetry/sdk-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { resourceFromAttributes } from '@opentelemetry/resources';
import {
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_VERSION,
} from '@opentelemetry/semantic-conventions';
import type { AppLogger, createLogger } from './common/observability/logger';
import { serviceInfo } from './common/observability/service-info';

// W3C Trace Context (the SDK's default propagators: tracecontext, baggage).
// Auto-instrumentation continues traces for HTTP/1.1 servers and clients,
// Express, Mongo, Redis, pg and the like. It does not reach HTTP/2 servers
// (the gRPC listener), message brokers, BullMQ jobs or Temporal workflows:
// those are propagated explicitly (infrastructure/rpc correlation
// interceptor, infrastructure/messaging/messaging.envelope.ts,
// common/observability/propagation.ts).
//
// Two auto-instrumentations are off because this code owns their job:
// kafkajs (messaging.envelope.ts propagates for every broker, so Kafka and
// Pulsar produce the same spans instead of Kafka producing two), and pino
// (the logger's mixin already writes trace_id/span_id on every record).
const service = serviceInfo();

const sdk = new NodeSDK({
  resource: resourceFromAttributes({
    [ATTR_SERVICE_NAME]: service.name,
    [ATTR_SERVICE_VERSION]: service.version,
    'deployment.environment': service.environment,
    'deployment.environment.name': service.environment,
    'service.role': service.role,
  }),
  traceExporter: new OTLPTraceExporter({
    url:
      process.env.OTEL_EXPORTER_OTLP_ENDPOINT ??
      'http://localhost:4318/v1/traces',
  }),
  instrumentations: [
    getNodeAutoInstrumentations({
      '@opentelemetry/instrumentation-kafkajs': { enabled: false },
      '@opentelemetry/instrumentation-pino': { enabled: false },
    }),
  ],
});

sdk.start();

// Flushes pending spans on SIGTERM; NestJS exits once its own shutdown hooks
// complete. The logger is required lazily so nothing it imports is loaded
// before the instrumentations are installed.
function tracingLogger(): AppLogger {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const logger = require('./common/observability/logger') as {
    createLogger: typeof createLogger;
  };
  return logger.createLogger('tracing');
}

process.on('SIGTERM', () => {
  sdk.shutdown().then(
    () => tracingLogger().info('sdk-shutdown', 'Tracing SDK shut down'),
    (err: unknown) =>
      tracingLogger().error(
        'sdk-shutdown-failed',
        'Tracing SDK shutdown failed',
        err,
      ),
  );
});
