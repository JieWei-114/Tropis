import { randomBytes } from 'crypto';
import {
  context,
  propagation,
  ROOT_CONTEXT,
  SpanKind,
  SpanStatusCode,
  trace,
  type Attributes,
  type Context,
  type Span,
} from '@opentelemetry/api';
import {
  currentRequestContext,
  runWithRequestContext,
} from './request-context';
import {
  activeSpanIds,
  newTraceId,
  parseTraceparent,
  TRACEPARENT_HEADER,
} from './trace-context';

/**
 * W3C Trace Context propagation for the boundaries auto-instrumentation does
 * not cover: message brokers, BullMQ job data, Temporal workflow memo or
 * headers. A carrier is any string map that travels with the work.
 *
 * Producer side: `injectTraceContext(carrier)` before enqueueing.
 * Consumer side: `runInExtractedSpan(carrier, name, opts, fn)` around the
 * handler, which continues the trace, binds the request context (so logs
 * carry the trace id and tenant) and ends the span with the outcome.
 */
export type TraceCarrier = Record<string, string>;

export const TRACER_NAME = 'tropis-backend';

export function tracer() {
  return trace.getTracer(TRACER_NAME);
}

/**
 * Writes `traceparent` (and `tracestate`) for `ctx` into the carrier. With
 * no OTel SDK registered the global propagator is a no-op; the trace id the
 * transport bound is then written instead, so correlation survives.
 */
export function injectTraceContext(
  carrier: TraceCarrier = {},
  ctx: Context = context.active(),
): TraceCarrier {
  propagation.inject(ctx, carrier);
  if (!carrier[TRACEPARENT_HEADER]) {
    const traceId =
      trace.getSpan(ctx)?.spanContext().traceId ??
      currentRequestContext()?.traceId;
    if (traceId && /^[0-9a-f]{32}$/.test(traceId) && !/^0+$/.test(traceId)) {
      carrier[TRACEPARENT_HEADER] =
        `00-${traceId}-${randomBytes(8).toString('hex')}-01`;
    }
  }
  return carrier;
}

/** The context a carrier describes, rooted when it carries none. */
export function extractTraceContext(
  carrier: Readonly<Record<string, string | undefined>>,
): Context {
  return propagation.extract(ROOT_CONTEXT, carrier, {
    keys: (c) => Object.keys(c),
    get: (c, key) => c[key] ?? c[key.toLowerCase()],
  });
}

/**
 * Runs `fn` in the context a carrier describes, without a span of its own,
 * with the request context bound to the carrier's trace id. For work that
 * resumes a stored trace (an outbox row) and whose own spans should be
 * children of it.
 */
export function runInExtractedContext<T>(
  carrier: Readonly<Record<string, string | undefined>>,
  opts: { tenantId?: string },
  fn: () => T,
): T {
  const parent = extractTraceContext(carrier);
  const traceId =
    parseTraceparent(carrier[TRACEPARENT_HEADER])?.traceId ?? newTraceId();
  return context.with(parent, () =>
    runWithRequestContext({ traceId, tenantId: opts.tenantId }, fn),
  );
}

export interface ExtractedSpanOptions {
  kind?: SpanKind;
  attributes?: Attributes;
  /** Tenant to bind for logs and to record as `tenant.id`. */
  tenantId?: string;
}

/**
 * Runs `fn` in a new span continuing the carrier's trace, with the request
 * context bound to that trace id. The span records an exception and error
 * status when `fn` throws, and always ends.
 */
export async function runInExtractedSpan<T>(
  carrier: Readonly<Record<string, string | undefined>>,
  name: string,
  opts: ExtractedSpanOptions,
  fn: (span: Span) => Promise<T> | T,
): Promise<T> {
  const parent = extractTraceContext(carrier);
  const attributes: Attributes = { ...opts.attributes };
  if (opts.tenantId) attributes['tenant.id'] = opts.tenantId;
  const span = tracer().startSpan(
    name,
    { kind: opts.kind ?? SpanKind.CONSUMER, attributes },
    parent,
  );
  const ctx = trace.setSpan(parent, span);
  const traceId =
    activeSpanIdsIn(span) ??
    parseTraceparent(carrier[TRACEPARENT_HEADER])?.traceId ??
    newTraceId();
  return context.with(ctx, () =>
    runWithRequestContext({ traceId, tenantId: opts.tenantId }, async () => {
      try {
        return await fn(span);
      } catch (err) {
        recordSpanError(span, err);
        throw err;
      } finally {
        span.end();
      }
    }),
  );
}

function activeSpanIdsIn(span: Span): string | undefined {
  const sc = span.spanContext();
  return /^0+$/.test(sc.traceId) ? undefined : sc.traceId;
}

export function recordSpanError(span: Span, err: unknown): void {
  if (err instanceof Error) span.recordException(err);
  span.setStatus({
    code: SpanStatusCode.ERROR,
    message: err instanceof Error ? err.name : 'error',
  });
}

/** Records `tenant.id` on the active span, if any. */
export function setSpanTenant(tenantId: string | undefined): void {
  if (!tenantId) return;
  trace.getActiveSpan()?.setAttribute('tenant.id', tenantId);
}

export { activeSpanIds };
