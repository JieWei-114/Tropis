import { randomBytes } from 'crypto';
import { isSpanContextValid, trace } from '@opentelemetry/api';
import { currentRequestContext } from './request-context';

/** W3C traceparent: version-traceid-spanid-flags. */
const TRACEPARENT =
  /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;
const INVALID_TRACE_ID = '0'.repeat(32);
const INVALID_SPAN_ID = '0'.repeat(16);

export const TRACEPARENT_HEADER = 'traceparent';
export const TRACESTATE_HEADER = 'tracestate';
export const REQUEST_ID_HEADER = 'x-request-id';
/** Response header/trailer carrying the trace id on RPC responses. */
export const TRACE_ID_HEADER = 'trace-id';

export interface ParsedTraceparent {
  traceId: string;
  spanId: string;
  sampled: boolean;
}

export function parseTraceparent(
  value: string | undefined | null,
): ParsedTraceparent | undefined {
  const m = TRACEPARENT.exec((value ?? '').trim().toLowerCase());
  if (!m || m[1] === 'ff') return undefined;
  if (m[2] === INVALID_TRACE_ID || m[3] === INVALID_SPAN_ID) return undefined;
  return {
    traceId: m[2],
    spanId: m[3],
    sampled: (parseInt(m[4], 16) & 1) === 1,
  };
}

/** A fresh random W3C trace id, for work that starts with no trace. */
export function newTraceId(): string {
  let id = randomBytes(16).toString('hex');
  while (id === INVALID_TRACE_ID) id = randomBytes(16).toString('hex');
  return id;
}

/** Trace and span id of the active span, when one is valid. */
export function activeSpanIds():
  | { traceId: string; spanId: string }
  | undefined {
  const ctx = trace.getActiveSpan()?.spanContext();
  if (!ctx || !isSpanContextValid(ctx)) return undefined;
  return { traceId: ctx.traceId, spanId: ctx.spanId };
}

/**
 * The trace id of the work in progress: the active span's, else the one the
 * transport bound (which covers a process running without the OTel SDK).
 */
export function currentTraceId(): string | undefined {
  return activeSpanIds()?.traceId ?? currentRequestContext()?.traceId;
}

const TRACE_ID_KEY = Symbol.for('tropis.traceId');

interface HeaderCarrier {
  headers: Record<string, string | string[] | undefined>;
}

function header(req: HeaderCarrier, name: string): string | undefined {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
}

/**
 * The trace id of an incoming HTTP request, resolved once and memoised on
 * the request so every reader (pino-http's request id, the correlation
 * middleware, the exception filter) agrees: the active server span's trace
 * id, else the incoming `traceparent`'s, else a new one.
 */
export function requestTraceId(req: HeaderCarrier): string {
  const holder = req as unknown as Record<symbol, string | undefined>;
  const known = holder[TRACE_ID_KEY];
  if (known) return known;
  const id =
    activeSpanIds()?.traceId ??
    parseTraceparent(header(req, TRACEPARENT_HEADER))?.traceId ??
    newTraceId();
  holder[TRACE_ID_KEY] = id;
  return id;
}
