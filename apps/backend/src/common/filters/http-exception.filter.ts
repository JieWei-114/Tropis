import { ExceptionFilter, Catch, ArgumentsHost } from '@nestjs/common';
import { Request, Response } from 'express';
import { PROBLEM_CONTENT_TYPE } from '@tropis/shared';
import { BaseWsExceptionFilter } from '@nestjs/websockets';
import {
  normalizeError,
  pathOf,
  toProblemDetails,
  type NormalizedError,
} from '../errors';
import { createLogger, type AppLogger } from '../observability/logger';
import {
  REQUEST_ID_HEADER,
  requestTraceId,
} from '../observability/trace-context';
import { currentRequestContext } from '../observability/request-context';

/**
 * Renders every HTTP error as RFC 9457 problem details
 * (`application/problem+json`): type, title, status, detail, instance, plus
 * the extension members code, traceId, retryable, errors (field violations)
 * and checks (failed health probes). The mapping from thrown value to
 * catalog entry lives in common/errors/normalize.ts.
 *
 * An error no thrower anticipated is answered as INTERNAL with the generic
 * message and logged in full with the trace id, so the caller can quote the
 * id and an operator can find the cause.
 *
 * Every 429 carries a Retry-After header: the thrower's
 * `metadata.retryAfterSeconds`, else a default.
 *
 * Success bodies are not wrapped.
 */
/** Retry-After when the thrower did not say how long the limit lasts. */
const DEFAULT_RETRY_AFTER_SECONDS = 60;

/** Seconds for the Retry-After header of a 429: the thrower's, else the default. */
export function retryAfterSeconds(err: NormalizedError): string {
  const given = Number(err.metadata.retryAfterSeconds);
  return String(
    Number.isFinite(given) && given > 0
      ? Math.ceil(given)
      : DEFAULT_RETRY_AFTER_SECONDS,
  );
}

@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
  /** WebSocket hosts get Nest's default `exception` event, not HTTP JSON. */
  private readonly wsFilter = new BaseWsExceptionFilter();

  constructor(private readonly logger: AppLogger = createLogger('http')) {}

  catch(exception: unknown, host: ArgumentsHost) {
    // Registered as a catch-all, so gateway exceptions reach it too. RPC
    // errors never do: the RpcServer maps those itself
    // (infrastructure/rpc/rpc-errors.ts).
    if (host.getType() !== 'http') {
      return this.wsFilter.catch(exception, host);
    }

    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    const traceId = currentRequestContext()?.traceId ?? requestTraceId(request);
    const err = normalizeError(exception);
    const instance = pathOf(request.originalUrl ?? request.url);
    this.log(err, exception, request, instance);

    const problem = toProblemDetails(err, { instance, traceId });
    if (!response.headersSent) {
      response.setHeader(REQUEST_ID_HEADER, traceId);
      if (err.httpStatus === 429) {
        response.setHeader('Retry-After', retryAfterSeconds(err));
      }
      response.setHeader(
        'Content-Type',
        `${PROBLEM_CONTENT_TYPE}; charset=utf-8`,
      );
    }
    response.status(err.httpStatus).json(problem);
  }

  private log(
    err: NormalizedError,
    exception: unknown,
    request: Request,
    instance: string,
  ): void {
    const fields = {
      'http.request.method': request.method,
      'url.path': instance,
    };
    if (err.unexpected) {
      this.logger.error(
        'unhandled-error',
        'Unhandled error answered as INTERNAL',
        exception,
        fields,
      );
    } else if (err.checks) {
      this.logger.warn('health-check-failed', 'Health check failed', {
        ...fields,
        checks: err.checks,
      });
    } else if (err.httpStatus >= 500) {
      this.logger.warn(
        'request-failed',
        `Request failed with ${err.code}`,
        { ...fields, 'error.code': err.code },
        exception,
      );
    }
  }
}
