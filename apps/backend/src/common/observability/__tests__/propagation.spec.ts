import { context, SpanKind, trace } from '@opentelemetry/api';
import {
  extractTraceContext,
  injectTraceContext,
  runInExtractedSpan,
} from '../propagation';
import {
  currentRequestContext,
  runWithRequestContext,
} from '../request-context';
import {
  currentTraceId,
  parseTraceparent,
  requestTraceId,
} from '../trace-context';
import { installTracing, TRACE_ID, TRACEPARENT } from './harness';

describe('propagation without an OTel SDK', () => {
  it('writes the bound trace id so correlation survives', () => {
    const carrier = runWithRequestContext({ traceId: TRACE_ID }, () =>
      injectTraceContext(),
    );
    expect(parseTraceparent(carrier.traceparent)?.traceId).toBe(TRACE_ID);
    expect(injectTraceContext()).toEqual({});
  });

  it('binds the carrier trace id for the job, as BullMQ and Temporal will', async () => {
    const seen = await runInExtractedSpan(
      { traceparent: TRACEPARENT },
      'job',
      { tenantId: 'acme' },
      () => currentRequestContext(),
    );
    expect(seen).toEqual({ traceId: TRACE_ID, tenantId: 'acme' });
    expect(currentTraceId()).toBeUndefined();
  });
});

describe('propagation with the OTel SDK', () => {
  let otel: ReturnType<typeof installTracing>;
  beforeAll(() => {
    otel = installTracing();
  });
  afterAll(() => otel.shutdown());

  it('round-trips a trace through a carrier object (job data, workflow memo)', async () => {
    const tracer = trace.getTracer('t');
    const parent = tracer.startSpan('enqueue');
    const carrier = context.with(trace.setSpan(context.active(), parent), () =>
      injectTraceContext({}),
    );
    parent.end();
    expect(carrier.traceparent).toContain(parent.spanContext().traceId);

    const child = await runInExtractedSpan(carrier, 'process job', {}, (span) =>
      span.spanContext(),
    );
    expect(child.traceId).toBe(parent.spanContext().traceId);
    const span = otel.spans().find((s) => s.name === 'process job');
    expect(span?.kind).toBe(SpanKind.CONSUMER);
    expect(span?.parentSpanContext?.spanId).toBe(parent.spanContext().spanId);
  });

  it('extracts nothing from an empty carrier', () => {
    expect(trace.getSpan(extractTraceContext({}))).toBeUndefined();
  });

  it('records a failure on the span and rethrows', async () => {
    await expect(
      runInExtractedSpan({}, 'fails', {}, () => {
        throw new Error('x');
      }),
    ).rejects.toThrow('x');
    expect(otel.spans().find((s) => s.name === 'fails')?.status.code).toBe(2);
  });

  it('resolves an HTTP request trace id once', () => {
    const req = { headers: { traceparent: TRACEPARENT } };
    expect(requestTraceId(req)).toBe(TRACE_ID);
    req.headers.traceparent =
      '00-ffffffffffffffffffffffffffffffff-00f067aa0ba902b7-01';
    expect(requestTraceId(req)).toBe(TRACE_ID);
  });
});
