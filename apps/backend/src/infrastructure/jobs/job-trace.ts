import { context, SpanKind, trace } from '@opentelemetry/api';
import {
  injectTraceContext,
  recordSpanError,
  runInExtractedSpan,
  tracer,
  type TraceCarrier,
} from '../../common/observability/propagation';
import { jobMetrics } from './job-metrics';
import {
  attachJobScope,
  captureJobScope,
  detachJobScope,
  runInJobScope,
} from './job-tenant';

/**
 * W3C Trace Context for background jobs, shared by every jobs adapter.
 *
 * The producer's trace context travels inside the job data under
 * JOB_TRACE_FIELD, the one place every queue technology preserves, and is
 * removed again before a handler sees the data. Data that is not a plain
 * object travels unchanged and its job starts a new trace.
 *
 * Spans follow the OTel messaging conventions: a PRODUCER span
 * `publish <queue>` around the enqueue, and a CONSUMER span
 * `process <queue>` around each attempt, a child of the producer span.
 */
export const JOB_TRACE_FIELD = '__trace';

type Carrier = Record<string, string | undefined>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    !Buffer.isBuffer(value)
  );
}

export function attachTraceContext<T>(data: T, carrier: TraceCarrier): T {
  if (!isRecord(data) || Object.keys(carrier).length === 0) return data;
  return { ...data, [JOB_TRACE_FIELD]: carrier } as T;
}

export function detachTraceContext(data: unknown): {
  data: unknown;
  carrier: Carrier;
} {
  if (!isRecord(data) || !(JOB_TRACE_FIELD in data)) {
    return { data, carrier: {} };
  }
  const { [JOB_TRACE_FIELD]: raw, ...rest } = data;
  const carrier: Carrier = {};
  if (isRecord(raw)) {
    for (const [key, value] of Object.entries(raw)) {
      if (typeof value === 'string') carrier[key] = value;
    }
  }
  return { data: rest, carrier };
}

/**
 * Runs `enqueue` inside a PRODUCER span, handing it the job data with that
 * span's trace context and the caller's tenant scope attached. Rejects with
 * TENANT_REQUIRED before anything is enqueued when the caller has no scope.
 */
export async function enqueueWithTrace<T, R extends { id?: string }>(
  system: string,
  queue: string,
  name: string,
  data: T,
  enqueue: (traced: T) => Promise<R>,
): Promise<R> {
  const scoped = attachJobScope(data, captureJobScope());
  const span = tracer().startSpan(`publish ${queue}`, {
    kind: SpanKind.PRODUCER,
    attributes: {
      'messaging.system': system,
      'messaging.destination.name': queue,
      'messaging.operation.type': 'send',
      'messaging.operation.name': 'publish',
      'job.name': name,
    },
  });
  const ctx = trace.setSpan(context.active(), span);
  try {
    const traced = attachTraceContext(scoped, injectTraceContext({}, ctx));
    const result = await context.with(ctx, () => enqueue(traced));
    if (result.id) span.setAttribute('messaging.message.id', result.id);
    return result;
  } catch (err) {
    recordSpanError(span, err);
    throw err;
  } finally {
    span.end();
  }
}

export interface TracedJob {
  id?: string;
  name: string;
  data: unknown;
  attemptsMade: number;
}

/**
 * Runs one attempt of a job inside a CONSUMER span continuing the
 * producer's trace, inside the tenant scope the job carries (job-tenant.ts),
 * with the request context bound so log records carry the trace id and
 * tenant, counting the attempt as completed or failed (job-metrics.ts).
 * `fn` receives the data without the trace and tenant fields.
 */
export function processWithTrace<R>(
  system: string,
  queue: string,
  job: TracedJob,
  fn: (data: unknown) => Promise<R>,
): Promise<R> {
  const traced = detachTraceContext(job.data);
  const { data, scope } = detachJobScope(traced.data);
  const tenantId = scope?.scope === 'tenant' ? scope.tenantId : undefined;
  const attributes: Record<string, string | number> = {
    'messaging.system': system,
    'messaging.destination.name': queue,
    'messaging.operation.type': 'process',
    'messaging.operation.name': 'process',
    'job.name': job.name,
    'job.attempts_made': job.attemptsMade,
  };
  if (job.id) attributes['messaging.message.id'] = job.id;
  const metrics = jobMetrics();
  return runInExtractedSpan(
    traced.carrier,
    `process ${queue}`,
    { kind: SpanKind.CONSUMER, tenantId, attributes },
    () => runInJobScope(scope, () => fn(data)),
  ).then(
    (result) => {
      metrics.completed.inc({ queue });
      return result;
    },
    (err: unknown) => {
      metrics.failed.inc({ queue });
      throw err;
    },
  );
}
