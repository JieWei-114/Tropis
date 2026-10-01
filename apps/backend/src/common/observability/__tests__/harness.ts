import { Writable } from 'stream';
import { context, propagation, trace } from '@opentelemetry/api';
import { node, tracing } from '@opentelemetry/sdk-node';
import { configureRootLogger } from '../logger';

/**
 * A real OTel tracer provider (AsyncLocalStorage context, W3C propagator)
 * exporting to memory, as tracing.ts sets up in production minus the
 * auto-instrumentation.
 */
export function installTracing() {
  const exporter = new tracing.InMemorySpanExporter();
  const provider = new node.NodeTracerProvider({
    spanProcessors: [new tracing.SimpleSpanProcessor(exporter)],
  });
  provider.register();
  return {
    exporter,
    spans: () => exporter.getFinishedSpans(),
    reset: () => exporter.reset(),
    shutdown: async () => {
      await provider.shutdown();
      trace.disable();
      context.disable();
      propagation.disable();
    },
  };
}

/** Routes every log record into an array of parsed JSON objects. */
export function captureLogs(level = 'debug', env: NodeJS.ProcessEnv = {}) {
  const records: Array<Record<string, unknown>> = [];
  const destination = new Writable({
    write(chunk: Buffer, _enc, done) {
      for (const line of chunk.toString().split('\n')) {
        if (line.trim())
          records.push(JSON.parse(line) as Record<string, unknown>);
      }
      done();
    },
  });
  const logger = configureRootLogger({
    level,
    destination,
    env: { NODE_ENV: 'test', OTEL_SERVICE_NAME: 'tropis-test', ...env },
  });
  return { records, logger };
}

export const TRACE_ID = '4bf92f3577b34da6a3ce929d0e0e4736';
export const TRACEPARENT = `00-${TRACE_ID}-00f067aa0ba902b7-01`;

export const nextTick = () => new Promise((r) => setImmediate(r));
