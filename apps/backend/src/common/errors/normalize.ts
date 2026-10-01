import { STATUS_CODES } from 'http';
import { HttpException } from '@nestjs/common';
import {
  ERROR_CATALOG,
  errorCodeForHttpStatus,
  isErrorCode,
  type ErrorCode,
  type ErrorDefinition,
  type FieldViolation,
  type HealthCheckStatus,
} from '@tropis/shared';
import { AppError } from './app-error';
import { fieldViolationsFromMessages } from './validation';

/**
 * Any thrown value resolved to a catalog entry, ready for a transport to
 * render. This is the compatibility layer that keeps Nest HttpExceptions
 * meaningful until every module throws AppError:
 *
 * - AppError: its own code.
 * - HttpException whose response carries a catalog `code`: that code.
 * - HttpException whose message IS a catalog code
 *   (`new NotFoundException('USER_NOT_FOUND')`): that code, with no detail.
 * - HttpException with a list of messages (ValidationPipe): VALIDATION_FAILED
 *   with field violations.
 * - A failed Terminus health check: HEALTH_CHECK_FAILED with each probe's
 *   status (names and up/down only; probe messages can hold hosts and
 *   credentials).
 * - Any other HttpException: the generic code for its status; its message,
 *   which the thrower wrote for callers, becomes `detail`, except framework
 *   texts (Nest's "Cannot GET <url>", the throttler's message), which echo
 *   the request or name a library and are dropped.
 * - A body-parser/http-errors client error: the generic code for its status.
 * - Anything else: INTERNAL, flagged `unexpected` so it is logged in full
 *   and never described to the caller.
 */
export interface NormalizedError {
  code: ErrorCode;
  definition: ErrorDefinition;
  /** Status to answer REST with. */
  httpStatus: number;
  detail?: string;
  fieldViolations: FieldViolation[];
  metadata: Record<string, string>;
  checks?: HealthCheckStatus[];
  /** No thrower anticipated this error: log it with its stack. */
  unexpected: boolean;
  cause: unknown;
}

/** Errors from shared infrastructure recognised by name (no import cycle). */
const KNOWN_ERROR_NAMES: Readonly<Record<string, ErrorCode>> = {
  CapabilityDisabledError: 'CAPABILITY_DISABLED',
  CircuitBreakerOpenError: 'SERVICE_UNAVAILABLE',
};

function resolved(
  code: ErrorCode,
  cause: unknown,
  extra: Partial<NormalizedError> = {},
): NormalizedError {
  const definition = ERROR_CATALOG[code];
  return {
    code,
    definition,
    httpStatus: definition.httpStatus,
    fieldViolations: [],
    metadata: {},
    unexpected: false,
    cause,
    ...extra,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Terminus puts `{ status: 'error', info, error, details }` in the 503. */
function healthChecks(
  body: Record<string, unknown>,
): HealthCheckStatus[] | undefined {
  if (body.status !== 'error' || !isRecord(body.details)) return undefined;
  return Object.entries(body.details).map(([name, probe]) => ({
    name,
    status: isRecord(probe) && probe.status === 'up' ? 'up' : 'down',
  }));
}

/** Framework texts that describe the request or the library, not the error. */
const FRAMEWORK_MESSAGES = [
  /^Cannot [A-Z]+ /,
  /^ThrottlerException/,
  /^Too Many Requests$/,
];

function isDefaultMessage(
  message: string,
  status: number,
  body: Record<string, unknown> | undefined,
  definition: ErrorDefinition,
): boolean {
  return (
    FRAMEWORK_MESSAGES.some((re) => re.test(message)) ||
    message === body?.error ||
    message === STATUS_CODES[status] ||
    message === definition.publicMessage ||
    isErrorCode(message)
  );
}

function fromHttpException(err: HttpException): NormalizedError {
  const status = err.getStatus();
  const response = err.getResponse();
  const body = isRecord(response) ? response : undefined;
  let code: ErrorCode | undefined;
  let message: string | undefined;
  let fieldViolations: FieldViolation[] = [];
  let checks: HealthCheckStatus[] | undefined;

  if (typeof response === 'string') {
    message = response;
  } else if (body) {
    if (isErrorCode(body.code)) code = body.code;
    checks = status === 503 ? healthChecks(body) : undefined;
    if (checks && !code) code = 'HEALTH_CHECK_FAILED';
    if (Array.isArray(body.message)) {
      fieldViolations = fieldViolationsFromMessages(body.message);
      if (!code && status === 400) code = 'VALIDATION_FAILED';
    } else if (typeof body.message === 'string') {
      message = body.message;
    }
  }
  if (!code && message && isErrorCode(message)) code = message;
  code ??= errorCodeForHttpStatus(status);
  const definition = ERROR_CATALOG[code];
  const detail =
    message && !checks && !isDefaultMessage(message, status, body, definition)
      ? message
      : undefined;
  return resolved(code, err, {
    httpStatus: status,
    detail,
    fieldViolations,
    checks,
  });
}

interface HttpErrorsLike {
  status?: unknown;
  statusCode?: unknown;
  expose?: unknown;
  type?: unknown;
}

function fromHttpErrorsLike(err: HttpErrorsLike): NormalizedError | undefined {
  const status =
    typeof err.status === 'number'
      ? err.status
      : typeof err.statusCode === 'number'
        ? err.statusCode
        : undefined;
  if (err.expose !== true || !status || status < 400 || status >= 500) {
    return undefined;
  }
  const code = errorCodeForHttpStatus(status);
  const detail =
    err.type === 'entity.parse.failed'
      ? 'The request body is not valid JSON.'
      : undefined;
  return resolved(code, err, { httpStatus: status, detail });
}

export function normalizeError(err: unknown): NormalizedError {
  if (err instanceof AppError) {
    return resolved(err.code, err.cause ?? err, {
      detail: err.detail,
      fieldViolations: err.fieldViolations,
      metadata: err.metadata,
    });
  }
  if (err instanceof HttpException) return fromHttpException(err);
  if (err instanceof Error) {
    const known = KNOWN_ERROR_NAMES[err.name];
    if (known) return resolved(known, err);
    const httpLike = fromHttpErrorsLike(err as HttpErrorsLike);
    if (httpLike) return httpLike;
  }
  return resolved('INTERNAL', err, { unexpected: true });
}
