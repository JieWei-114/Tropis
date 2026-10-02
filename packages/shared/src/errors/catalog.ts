/**
 * The error catalog: every error that crosses an API boundary (REST, RPC,
 * WebSocket, SDK, helm) is one of these entries. Modelled on Google AIP-193.
 *
 * Rules for entries:
 * - `code` is UPPER_SNAKE, stable, and never reused for a different meaning.
 *   An entry that is no longer emitted stays here marked `deprecated`, so old
 *   clients keep resolving it.
 * - `publicMessage` is safe English shown to end users and used as the RFC
 *   9457 `title`; it never contains internal details. Per-occurrence context
 *   goes in `detail`, which must be equally safe.
 * - `httpStatus` is the REST status, `rpcCode` the Connect code name (the
 *   string key of `Code` in @connectrpc/connect), `retryable` whether the
 *   same request may succeed if repeated unchanged after a backoff.
 * - `domain` names the module that owns a domain-specific code; generic codes
 *   derived from a transport status carry none.
 *
 * Problem type URIs: every code has the type
 * `https://errors.tropis.dev/<code-kebab>` (USER_NOT_FOUND ->
 * https://errors.tropis.dev/user-not-found). `about:blank` is never emitted,
 * so a client can always recover the code from `type` alone.
 *
 * RPC error details: `google.rpc.ErrorInfo { reason: code, domain: "tropis" }`
 * carries the code; `google.rpc.BadRequest` carries field violations.
 *
 * Wire conventions shared by every contract:
 * - Timestamps in REST bodies, logs and events are ISO 8601 in UTC with a
 *   trailing `Z` (2026-09-30T08:15:00.000Z). The only exception is a proto
 *   field whose contract fixes an epoch value (e.g. `int64 *_ms`).
 * - Identifiers (user ids, event ids, trace ids, api keys) are opaque
 *   strings: clients compare them for equality and never parse them.
 */

/** Connect / gRPC status code names, as keys of `Code` in @connectrpc/connect. */
export const RPC_CODES = {
  Canceled: 1,
  Unknown: 2,
  InvalidArgument: 3,
  DeadlineExceeded: 4,
  NotFound: 5,
  AlreadyExists: 6,
  PermissionDenied: 7,
  ResourceExhausted: 8,
  FailedPrecondition: 9,
  Aborted: 10,
  OutOfRange: 11,
  Unimplemented: 12,
  Internal: 13,
  Unavailable: 14,
  DataLoss: 15,
  Unauthenticated: 16,
} as const;

export type RpcCodeName = keyof typeof RPC_CODES;

export interface ErrorDefinition {
  readonly code: string;
  readonly httpStatus: number;
  readonly rpcCode: RpcCodeName;
  readonly retryable: boolean;
  readonly publicMessage: string;
  readonly domain?: string;
  /** Still resolvable, no longer emitted; `replacedBy` names the successor. */
  readonly deprecated?: boolean;
  readonly replacedBy?: string;
}

type EntrySpec = Omit<ErrorDefinition, 'code'>;

function defineCatalog<const T extends Record<string, EntrySpec>>(
  entries: T,
): { readonly [K in keyof T]: T[K] & { readonly code: K } } {
  const out: Record<string, ErrorDefinition> = {};
  for (const [code, spec] of Object.entries(entries)) {
    out[code] = Object.freeze({ code, ...spec });
  }
  return Object.freeze(out) as {
    readonly [K in keyof T]: T[K] & { readonly code: K };
  };
}

export const ERROR_CATALOG = defineCatalog({
  // Generic codes, one per transport status.
  BAD_REQUEST: {
    httpStatus: 400,
    rpcCode: 'InvalidArgument',
    retryable: false,
    publicMessage: 'The request is invalid.',
  },
  VALIDATION_FAILED: {
    httpStatus: 400,
    rpcCode: 'InvalidArgument',
    retryable: false,
    publicMessage: 'One or more fields are invalid.',
  },
  FAILED_PRECONDITION: {
    httpStatus: 400,
    rpcCode: 'FailedPrecondition',
    retryable: false,
    publicMessage: 'The request cannot be performed in the current state.',
  },
  UNAUTHORIZED: {
    httpStatus: 401,
    rpcCode: 'Unauthenticated',
    retryable: false,
    publicMessage: 'Authentication is required.',
  },
  FORBIDDEN: {
    httpStatus: 403,
    rpcCode: 'PermissionDenied',
    retryable: false,
    publicMessage: 'You do not have permission to perform this action.',
  },
  NOT_FOUND: {
    httpStatus: 404,
    rpcCode: 'NotFound',
    retryable: false,
    publicMessage: 'The requested resource was not found.',
  },
  METHOD_NOT_ALLOWED: {
    httpStatus: 405,
    rpcCode: 'Unimplemented',
    retryable: false,
    publicMessage: 'This method is not allowed on the resource.',
  },
  CONFLICT: {
    httpStatus: 409,
    rpcCode: 'AlreadyExists',
    retryable: false,
    publicMessage: 'The request conflicts with the current state.',
  },
  ABORTED: {
    httpStatus: 409,
    rpcCode: 'Aborted',
    retryable: true,
    publicMessage: 'The operation was aborted by a concurrent change.',
  },
  PAYLOAD_TOO_LARGE: {
    httpStatus: 413,
    rpcCode: 'ResourceExhausted',
    retryable: false,
    publicMessage: 'The request body is too large.',
  },
  UNSUPPORTED_MEDIA_TYPE: {
    httpStatus: 415,
    rpcCode: 'InvalidArgument',
    retryable: false,
    publicMessage: 'The request content type is not supported.',
  },
  UNPROCESSABLE: {
    httpStatus: 422,
    rpcCode: 'InvalidArgument',
    retryable: false,
    publicMessage: 'The request could not be processed.',
  },
  RATE_LIMITED: {
    httpStatus: 429,
    rpcCode: 'ResourceExhausted',
    retryable: true,
    publicMessage: 'Too many requests. Slow down and try again later.',
  },
  CANCELLED: {
    httpStatus: 499,
    rpcCode: 'Canceled',
    retryable: false,
    publicMessage: 'The request was cancelled.',
  },
  INTERNAL: {
    httpStatus: 500,
    rpcCode: 'Internal',
    retryable: false,
    publicMessage: 'An internal error occurred.',
  },
  NOT_IMPLEMENTED: {
    httpStatus: 501,
    rpcCode: 'Unimplemented',
    retryable: false,
    publicMessage: 'This operation is not implemented.',
  },
  BAD_GATEWAY: {
    httpStatus: 502,
    rpcCode: 'Unavailable',
    retryable: true,
    publicMessage: 'An upstream service returned an invalid response.',
  },
  SERVICE_UNAVAILABLE: {
    httpStatus: 503,
    rpcCode: 'Unavailable',
    retryable: true,
    publicMessage: 'The service is temporarily unavailable.',
  },
  GATEWAY_TIMEOUT: {
    httpStatus: 504,
    rpcCode: 'DeadlineExceeded',
    retryable: true,
    publicMessage: 'The request timed out.',
  },
  INTERNAL_ERROR: {
    httpStatus: 500,
    rpcCode: 'Internal',
    retryable: false,
    publicMessage: 'An internal error occurred.',
    deprecated: true,
    replacedBy: 'INTERNAL',
  },
  HTTP_ERROR: {
    httpStatus: 500,
    rpcCode: 'Unknown',
    retryable: false,
    publicMessage: 'The request failed.',
    deprecated: true,
    replacedBy: 'BAD_REQUEST',
  },

  // Platform.
  HEALTH_CHECK_FAILED: {
    httpStatus: 503,
    rpcCode: 'Unavailable',
    retryable: true,
    publicMessage: 'One or more dependencies are unavailable.',
    domain: 'health',
  },
  CAPABILITY_DISABLED: {
    httpStatus: 501,
    rpcCode: 'Unimplemented',
    retryable: false,
    publicMessage: 'This feature is disabled on this server.',
    domain: 'capability',
  },

  // Tenancy.
  TENANT_REQUIRED: {
    httpStatus: 400,
    rpcCode: 'InvalidArgument',
    retryable: false,
    publicMessage: 'The request does not identify a tenant.',
    domain: 'tenancy',
  },
  TENANT_INVALID: {
    httpStatus: 400,
    rpcCode: 'InvalidArgument',
    retryable: false,
    publicMessage: 'The tenant id is malformed.',
    domain: 'tenancy',
  },
  TENANT_MISMATCH: {
    httpStatus: 403,
    rpcCode: 'PermissionDenied',
    retryable: false,
    publicMessage: 'The requested tenant does not match the credentials.',
    domain: 'tenancy',
  },
  TENANT_NOT_FOUND: {
    httpStatus: 404,
    rpcCode: 'NotFound',
    retryable: false,
    publicMessage: 'The tenant is not registered.',
    domain: 'tenancy',
  },
  TENANT_INACTIVE: {
    httpStatus: 403,
    rpcCode: 'PermissionDenied',
    retryable: false,
    publicMessage: 'The tenant is not active.',
    domain: 'tenancy',
  },
  TENANT_SIGNUP_CLOSED: {
    httpStatus: 403,
    rpcCode: 'PermissionDenied',
    retryable: false,
    publicMessage: 'The tenant does not allow self sign-up.',
    domain: 'tenancy',
  },

  // User module.
  USER_NOT_FOUND: {
    httpStatus: 404,
    rpcCode: 'NotFound',
    retryable: false,
    publicMessage: 'The user was not found.',
    domain: 'user',
  },
  USER_ALREADY_EXISTS: {
    httpStatus: 409,
    rpcCode: 'AlreadyExists',
    retryable: false,
    publicMessage: 'A user with this email already exists.',
    domain: 'user',
  },
  USER_LAST_ADMIN: {
    httpStatus: 409,
    rpcCode: 'FailedPrecondition',
    retryable: false,
    publicMessage: 'The last admin of a tenant cannot be removed.',
    domain: 'user',
  },

  // Auth module.
  AUTH_INVALID_CREDENTIALS: {
    httpStatus: 401,
    rpcCode: 'Unauthenticated',
    retryable: false,
    publicMessage: 'The email or password is incorrect.',
    domain: 'auth',
  },
  AUTH_TOKEN_INVALID: {
    httpStatus: 401,
    rpcCode: 'Unauthenticated',
    retryable: false,
    publicMessage: 'The access token is invalid or expired.',
    domain: 'auth',
  },
  AUTH_TOKEN_REVOKED: {
    httpStatus: 401,
    rpcCode: 'Unauthenticated',
    retryable: false,
    publicMessage: 'The access token has been revoked.',
    domain: 'auth',
  },
  AUTH_ACCOUNT_INACTIVE: {
    httpStatus: 401,
    rpcCode: 'Unauthenticated',
    retryable: false,
    publicMessage: 'The account is not active.',
    domain: 'auth',
  },
  AUTH_LOGIN_LOCKED: {
    httpStatus: 429,
    rpcCode: 'ResourceExhausted',
    retryable: true,
    publicMessage: 'Too many failed sign-in attempts. Try again later.',
    domain: 'auth',
  },
  AUTH_CSRF_REJECTED: {
    httpStatus: 403,
    rpcCode: 'PermissionDenied',
    retryable: false,
    publicMessage: 'The request did not come from an allowed origin.',
    domain: 'auth',
  },
  AUTH_CURRENT_PASSWORD_REQUIRED: {
    httpStatus: 403,
    rpcCode: 'PermissionDenied',
    retryable: false,
    publicMessage:
      'Changing the password or email requires the correct current password.',
    domain: 'auth',
  },
  OAUTH_ACCOUNT_EXISTS: {
    httpStatus: 409,
    rpcCode: 'AlreadyExists',
    retryable: false,
    publicMessage:
      'An account with this email already exists. Sign in with its password.',
    domain: 'auth',
  },
  OAUTH_NOT_CONFIGURED: {
    httpStatus: 501,
    rpcCode: 'Unimplemented',
    retryable: false,
    publicMessage: 'This sign-in provider is not configured.',
    domain: 'auth',
  },
  OAUTH_STATE_INVALID: {
    httpStatus: 400,
    rpcCode: 'InvalidArgument',
    retryable: false,
    publicMessage: 'The sign-in request is invalid or has expired.',
    domain: 'auth',
  },
  OAUTH_CODE_INVALID: {
    httpStatus: 401,
    rpcCode: 'Unauthenticated',
    retryable: false,
    publicMessage: 'The sign-in code is invalid or has expired.',
    domain: 'auth',
  },

  // Request signing (docs/api-conventions.md): all map to 401.
  API_KEY_UNKNOWN: {
    httpStatus: 401,
    rpcCode: 'Unauthenticated',
    retryable: false,
    publicMessage: 'The API key is not recognised.',
    domain: 'signing',
  },
  SIGNATURE_INVALID: {
    httpStatus: 401,
    rpcCode: 'Unauthenticated',
    retryable: false,
    publicMessage: 'The request signature is invalid.',
    domain: 'signing',
  },
  SIGNATURE_EXPIRED: {
    httpStatus: 401,
    rpcCode: 'Unauthenticated',
    retryable: false,
    publicMessage: 'The request signature has expired.',
    domain: 'signing',
  },
  NONCE_REUSED: {
    httpStatus: 401,
    rpcCode: 'Unauthenticated',
    retryable: false,
    publicMessage: 'The request nonce was already used.',
    domain: 'signing',
  },
});

export type ErrorCode = keyof typeof ERROR_CATALOG;

/** `domain` of google.rpc.ErrorInfo for every error this system emits. */
export const ERROR_DOMAIN = 'tropis';

/** Prefix of every RFC 9457 problem `type`. */
export const ERROR_TYPE_BASE_URI = 'https://errors.tropis.dev/';

/** Media type of RFC 9457 error bodies. */
export const PROBLEM_CONTENT_TYPE = 'application/problem+json';

/** Generic code for a transport status, used when the thrower named none. */
const GENERIC_BY_HTTP_STATUS: Readonly<Record<number, ErrorCode>> = {
  400: 'BAD_REQUEST',
  401: 'UNAUTHORIZED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  405: 'METHOD_NOT_ALLOWED',
  409: 'CONFLICT',
  413: 'PAYLOAD_TOO_LARGE',
  415: 'UNSUPPORTED_MEDIA_TYPE',
  422: 'UNPROCESSABLE',
  429: 'RATE_LIMITED',
  499: 'CANCELLED',
  500: 'INTERNAL',
  501: 'NOT_IMPLEMENTED',
  502: 'BAD_GATEWAY',
  503: 'SERVICE_UNAVAILABLE',
  504: 'GATEWAY_TIMEOUT',
};

const GENERIC_BY_RPC_CODE: Readonly<Record<RpcCodeName, ErrorCode>> = {
  Canceled: 'CANCELLED',
  Unknown: 'INTERNAL',
  InvalidArgument: 'BAD_REQUEST',
  DeadlineExceeded: 'GATEWAY_TIMEOUT',
  NotFound: 'NOT_FOUND',
  AlreadyExists: 'CONFLICT',
  PermissionDenied: 'FORBIDDEN',
  ResourceExhausted: 'RATE_LIMITED',
  FailedPrecondition: 'FAILED_PRECONDITION',
  Aborted: 'ABORTED',
  OutOfRange: 'BAD_REQUEST',
  Unimplemented: 'NOT_IMPLEMENTED',
  Internal: 'INTERNAL',
  Unavailable: 'SERVICE_UNAVAILABLE',
  DataLoss: 'INTERNAL',
  Unauthenticated: 'UNAUTHORIZED',
};

export function isErrorCode(value: unknown): value is ErrorCode {
  return (
    typeof value === 'string' &&
    Object.prototype.hasOwnProperty.call(ERROR_CATALOG, value)
  );
}

export function getErrorDefinition(code: ErrorCode): ErrorDefinition {
  return ERROR_CATALOG[code];
}

/**
 * Generic code for an HTTP status: the exact entry when one exists, else
 * BAD_REQUEST for any other 4xx and INTERNAL for anything else.
 */
export function errorCodeForHttpStatus(status: number): ErrorCode {
  const exact = GENERIC_BY_HTTP_STATUS[status];
  if (exact) return exact;
  return status >= 400 && status < 500 ? 'BAD_REQUEST' : 'INTERNAL';
}

/** Generic code for a Connect code, by name or by number. */
export function errorCodeForRpcCode(rpc: RpcCodeName | number): ErrorCode {
  const name = typeof rpc === 'number' ? rpcCodeName(rpc) : rpc;
  return name ? GENERIC_BY_RPC_CODE[name] : 'INTERNAL';
}

export function rpcCodeName(value: number): RpcCodeName | undefined {
  return (Object.keys(RPC_CODES) as RpcCodeName[]).find(
    (k) => RPC_CODES[k] === value,
  );
}

export function rpcCodeNumber(name: RpcCodeName): number {
  return RPC_CODES[name];
}

/** `USER_NOT_FOUND` -> `https://errors.tropis.dev/user-not-found`. */
export function errorTypeUri(code: ErrorCode): string {
  return `${ERROR_TYPE_BASE_URI}${code.toLowerCase().replace(/_/g, '-')}`;
}

/** Inverse of errorTypeUri; undefined for a URI outside the catalog. */
export function errorCodeFromTypeUri(uri: string): ErrorCode | undefined {
  if (!uri.startsWith(ERROR_TYPE_BASE_URI)) return undefined;
  const code = uri
    .slice(ERROR_TYPE_BASE_URI.length)
    .toUpperCase()
    .replace(/-/g, '_');
  return isErrorCode(code) ? code : undefined;
}

/** Every catalog entry, in declaration order. */
export function listErrorDefinitions(): ErrorDefinition[] {
  return Object.values(ERROR_CATALOG);
}
