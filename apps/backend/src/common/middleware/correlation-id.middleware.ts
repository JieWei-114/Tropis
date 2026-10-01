import { Injectable, NestMiddleware } from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';
import { trace } from '@opentelemetry/api';
import {
  currentRequestContext,
  NO_REQUEST_CONTEXT,
  runWithRequestContext,
} from '../observability/request-context';
import {
  REQUEST_ID_HEADER,
  requestTraceId,
} from '../observability/trace-context';

/**
 * The correlation id of the current request, RPC or consumed message. It is
 * the W3C trace id, so one id joins the response header, the error body, the
 * log records and the trace.
 */
export function getRequestId(): string {
  return currentRequestContext()?.traceId ?? NO_REQUEST_CONTEXT;
}

/**
 * Runs `fn` with `requestId` (a trace id) as the current correlation id.
 * Transports that do not pass through Express bind it with this.
 */
export function runWithRequestId<T>(requestId: string, fn: () => T): T {
  return runWithRequestContext({ traceId: requestId }, fn);
}

/** Span attribute holding a caller-supplied `x-request-id`. */
export const CLIENT_REQUEST_ID_ATTRIBUTE = 'http.request.header.x-request-id';

/**
 * Binds the request's trace id as its correlation id and echoes it in
 * `x-request-id`. An incoming `x-request-id` is never adopted (a caller
 * could otherwise collide or spoof ids); it is kept as a span attribute so a
 * client's own id can still be searched for.
 */
@Injectable()
export class CorrelationIdMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction): void {
    const traceId = requestTraceId(req);
    const incoming = req.headers[REQUEST_ID_HEADER];
    const clientRequestId = Array.isArray(incoming) ? incoming[0] : incoming;
    if (clientRequestId) {
      trace
        .getActiveSpan()
        ?.setAttribute(CLIENT_REQUEST_ID_ATTRIBUTE, [clientRequestId]);
    }
    res.setHeader(REQUEST_ID_HEADER, traceId);
    runWithRequestContext({ traceId, clientRequestId }, () => next());
  }
}
