/**
 * Error normalization: turns a ConnectError (with google.rpc.ErrorInfo /
 * BadRequest details), an RFC 9457 problem body from a REST endpoint, a fetch
 * failure or any other thrown value into one ApiError shape for the UI.
 *
 * Codes, statuses and retryability come from the error catalog in
 * @tropis/shared, the same table the backend renders errors from. The code,
 * message and retryability the server sent win; the catalog fills in what a
 * response leaves out, and the transport status is the last resort when a
 * response carries no code at all (a proxy, a network failure). Two codes
 * never come from the server: NETWORK_ERROR (no response was received) and
 * INTERNAL for a thrown value the SDK cannot interpret.
 */

import { Code, ConnectError } from '@connectrpc/connect';
import {
  ERROR_CATALOG,
  ERROR_DOMAIN,
  HEADERS,
  errorCodeForHttpStatus,
  errorCodeForRpcCode,
  errorCodeFromTypeUri,
  isErrorCode,
  type ErrorDefinition,
  type FieldViolation,
  type ProblemDetails as CatalogProblemDetails,
} from '@tropis/shared';
import {
  BadRequestSchema,
  ErrorInfoSchema,
} from '../gen/google/rpc/error_details_pb';

export { ERROR_DOMAIN };

/** One invalid field, named as on the wire (google.rpc.BadRequest). */
export type FieldError = FieldViolation;

export interface ApiError {
  /** Catalog code (USER_NOT_FOUND, VALIDATION_FAILED, ...). */
  code: string;
  /** Safe, human-readable message. */
  message: string;
  /** HTTP status, or the HTTP equivalent of the RPC code. 0 when no response. */
  status: number;
  /** Connect code number for RPC errors. */
  rpcCode?: number;
  /** Whether repeating the same request later may succeed. */
  retryable: boolean;
  fieldErrors: FieldError[];
  /** Trace id to quote when reporting the problem. */
  traceId?: string;
  isAuth: boolean;
  isNetwork: boolean;
}

/**
 * RFC 9457 problem details as a client receives them: `type`, `title` and
 * `status` are always present; the extension members may be missing when a
 * proxy or an older server wrote the body, and `code` may name an entry this
 * SDK's catalog does not know yet.
 */
export type ProblemDetails = Pick<
  CatalogProblemDetails,
  'type' | 'title' | 'status'
> &
  Partial<Omit<CatalogProblemDetails, 'type' | 'title' | 'status' | 'code'>> & {
    code?: string;
  };

/**
 * A non-2xx REST response. REST helpers throw it (build one with
 * readApiError) so parseApiError can read the problem body.
 */
export class ApiRequestError extends Error {
  constructor(
    readonly status: number,
    readonly problem?: ProblemDetails,
    readonly traceId?: string,
  ) {
    super(
      problem?.detail ??
        // A validation problem's title is generic; the field reasons are
        // what the user can act on.
        (problem?.errors?.length
          ? problem.errors.map((e) => e.description).join('; ')
          : undefined) ??
        problem?.title ??
        `Request failed: ${status}`,
    );
    this.name = 'ApiRequestError';
  }
}

/** Whether a decoded body is an RFC 9457 problem document. */
export function isProblemBody(value: unknown): value is ProblemDetails {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.type === 'string' &&
    typeof v.title === 'string' &&
    typeof v.status === 'number'
  );
}

/** Reads a failed fetch Response into an ApiRequestError. */
export async function readApiError(res: Response): Promise<ApiRequestError> {
  const body: unknown = await res.json().catch(() => undefined);
  return new ApiRequestError(
    res.status,
    isProblemBody(body) ? body : undefined,
    res.headers.get(HEADERS.REQUEST_ID) ?? undefined,
  );
}

const NETWORK_MESSAGE = 'Network error — check your connection';

function definitionOf(code: string): ErrorDefinition | undefined {
  return isErrorCode(code) ? ERROR_CATALOG[code] : undefined;
}

/** 401 and 403 entries: the caller must sign in again or lacks access. */
function isAuthStatus(status: number): boolean {
  return status === 401 || status === 403;
}

function fromConnectError(err: ConnectError): ApiError {
  const info = err
    .findDetails(ErrorInfoSchema)
    .find((d) => d.domain === ERROR_DOMAIN);
  const violations = err
    .findDetails(BadRequestSchema)
    .flatMap((b) => b.fieldViolations);
  const transport = ERROR_CATALOG[errorCodeForRpcCode(err.code)];
  const code = info?.reason || transport.code;
  const definition = definitionOf(code) ?? transport;
  const retryableMeta = info?.metadata.retryable;
  const isNetwork = !info && err.code === Code.Unavailable;
  return {
    code: isNetwork ? 'NETWORK_ERROR' : code,
    message: isNetwork
      ? NETWORK_MESSAGE
      : info
        ? err.rawMessage
        : transport.publicMessage,
    status: definition.httpStatus,
    rpcCode: err.code,
    retryable:
      retryableMeta !== undefined
        ? retryableMeta === 'true'
        : definition.retryable,
    fieldErrors: violations.map((v) => ({
      field: v.field,
      description: v.description,
    })),
    traceId:
      err.metadata.get(HEADERS.TRACE_ID) ??
      err.metadata.get(HEADERS.REQUEST_ID) ??
      undefined,
    isAuth:
      isAuthStatus(definition.httpStatus) ||
      err.code === Code.Unauthenticated ||
      err.code === Code.PermissionDenied,
    isNetwork,
  };
}

function fromProblem(
  problem: ProblemDetails,
  traceId: string | undefined,
): ApiError {
  const code =
    problem.code ??
    errorCodeFromTypeUri(problem.type) ??
    errorCodeForHttpStatus(problem.status);
  const definition =
    definitionOf(code) ?? ERROR_CATALOG[errorCodeForHttpStatus(problem.status)];
  return {
    code,
    message: problem.detail ?? problem.title,
    status: problem.status,
    retryable: problem.retryable ?? definition.retryable,
    fieldErrors: (problem.errors ?? []).map((e) => ({
      field: e.field,
      description: e.description,
    })),
    traceId: problem.traceId ?? traceId,
    isAuth: isAuthStatus(problem.status) || isAuthStatus(definition.httpStatus),
    isNetwork: false,
  };
}

function fromStatus(status: number, traceId: string | undefined): ApiError {
  const definition = ERROR_CATALOG[errorCodeForHttpStatus(status)];
  return {
    code: definition.code,
    message: definition.publicMessage,
    status,
    retryable: definition.retryable,
    fieldErrors: [],
    traceId,
    isAuth: isAuthStatus(status),
    isNetwork: false,
  };
}

/**
 * Normalize any thrown value (ConnectError, REST error, fetch Error,
 * unknown) into an ApiError. Use this in catch blocks instead of casting the
 * raw error, so the UI always has a safe message and a code.
 */
export function parseApiError(err: unknown): ApiError {
  if (err instanceof ConnectError) return fromConnectError(err);

  if (err instanceof ApiRequestError) {
    return err.problem
      ? fromProblem(err.problem, err.traceId)
      : fromStatus(err.status, err.traceId);
  }

  if (isProblemBody(err)) return fromProblem(err, undefined);

  if (err instanceof Error) {
    const isNetwork =
      err.message.includes('Failed to fetch') ||
      err.message.includes('NetworkError') ||
      err.message.includes('net::') ||
      err.message.includes('timed out');
    return {
      code: isNetwork ? 'NETWORK_ERROR' : 'INTERNAL',
      message: isNetwork ? NETWORK_MESSAGE : err.message,
      status: 0,
      retryable: isNetwork,
      fieldErrors: [],
      isAuth: false,
      isNetwork,
    };
  }

  return {
    code: 'INTERNAL',
    message: 'An unexpected error occurred',
    status: 0,
    retryable: false,
    fieldErrors: [],
    isAuth: false,
    isNetwork: false,
  };
}
