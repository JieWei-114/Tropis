import {
  context,
  propagation,
  SpanKind,
  SpanStatusCode,
  trace,
  type Context,
} from '@opentelemetry/api';
import { Code, ConnectError, type Interceptor } from '@connectrpc/connect';
import { runWithRequestContext } from '../../../common/observability/request-context';
import { tracer } from '../../../common/observability/propagation';
import {
  activeSpanIds,
  newTraceId,
  parseTraceparent,
  REQUEST_ID_HEADER,
  TRACE_ID_HEADER,
  TRACEPARENT_HEADER,
} from '../../../common/observability/trace-context';
import { CLIENT_REQUEST_ID_ATTRIBUTE } from '../../../common/middleware/correlation-id.middleware';

export { REQUEST_ID_HEADER };

/** Connect codes that mark a server span as failed (OTel RPC semconv). */
const SERVER_ERROR_CODES = new Set<Code>([
  Code.Unknown,
  Code.DeadlineExceeded,
  Code.Unimplemented,
  Code.Internal,
  Code.Unavailable,
  Code.DataLoss,
]);

/** `Code.NotFound` -> `not_found`, the Connect protocol's code string. */
export function connectCodeString(code: Code): string {
  return Code[code].replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase();
}

/**
 * Continues the caller's W3C trace for the call and binds its trace id as
 * the correlation id.
 *
 * The HTTP/1.1 path is already inside the auto-instrumented HTTP server
 * span, so the RPC span becomes its child. HTTP/2 (gRPC) is not covered by
 * auto-instrumentation, so the parent is extracted from `traceparent` here.
 * The span is named `<service>/<method>` with the OTel RPC attributes.
 *
 * The trace id is echoed as `x-request-id` and `trace-id` on the response
 * (headers on success, error metadata, i.e. trailers for gRPC, on failure).
 * An incoming `x-request-id` is recorded as a span attribute, never adopted.
 */
export const correlationInterceptor: Interceptor = (next) => (req) => {
  const service = req.method.parent.typeName;
  const method = req.method.name;
  const inHttpSpan = activeSpanIds() !== undefined;
  const parent: Context = inHttpSpan
    ? context.active()
    : propagation.extract(context.active(), req.header, {
        keys: (h) => [...h.keys()],
        get: (h, key) => h.get(key) ?? undefined,
      });
  const span = tracer().startSpan(
    `${service}/${method}`,
    {
      kind: inHttpSpan ? SpanKind.INTERNAL : SpanKind.SERVER,
      attributes: {
        'rpc.system': 'connect_rpc',
        'rpc.service': service,
        'rpc.method': method,
      },
    },
    parent,
  );
  const clientRequestId = req.header.get(REQUEST_ID_HEADER) ?? undefined;
  if (clientRequestId) {
    span.setAttribute(CLIENT_REQUEST_ID_ATTRIBUTE, [clientRequestId]);
  }
  const spanTraceId = span.spanContext().traceId;
  const traceId = /^0+$/.test(spanTraceId)
    ? (parseTraceparent(req.header.get(TRACEPARENT_HEADER))?.traceId ??
      newTraceId())
    : spanTraceId;

  return context.with(trace.setSpan(parent, span), () =>
    runWithRequestContext({ traceId, clientRequestId }, async () => {
      try {
        const res = await next(req);
        res.header.set(REQUEST_ID_HEADER, traceId);
        res.header.set(TRACE_ID_HEADER, traceId);
        return res;
      } catch (err) {
        if (err instanceof ConnectError) {
          err.metadata.set(REQUEST_ID_HEADER, traceId);
          err.metadata.set(TRACE_ID_HEADER, traceId);
          span.setAttribute(
            'rpc.connect_rpc.error_code',
            connectCodeString(err.code),
          );
          if (SERVER_ERROR_CODES.has(err.code)) {
            span.setStatus({
              code: SpanStatusCode.ERROR,
              message: Code[err.code],
            });
          }
        } else {
          span.setStatus({ code: SpanStatusCode.ERROR });
        }
        throw err;
      } finally {
        span.end();
      }
    }),
  );
};
