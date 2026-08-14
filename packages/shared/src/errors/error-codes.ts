/**
 * Unified error-code table shared across apps (backend, frontend, SDKs).
 *
 * Every error surfaced over an API boundary carries one of these stable,
 * machine-readable codes.
 */
export const ERROR_CODES = {
  // ── Generic HTTP-derived codes ──────────────────────────────────
  BAD_REQUEST: 'BAD_REQUEST',
  UNAUTHORIZED: 'UNAUTHORIZED',
  FORBIDDEN: 'FORBIDDEN',
  NOT_FOUND: 'NOT_FOUND',
  CONFLICT: 'CONFLICT',
  UNPROCESSABLE: 'UNPROCESSABLE',
  RATE_LIMITED: 'RATE_LIMITED',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
  BAD_GATEWAY: 'BAD_GATEWAY',
  SERVICE_UNAVAILABLE: 'SERVICE_UNAVAILABLE',
  HTTP_ERROR: 'HTTP_ERROR',

  // ── User module ─────────────────────────────────────────────────
  USER_NOT_FOUND: 'USER_NOT_FOUND',
  USER_ALREADY_EXISTS: 'USER_ALREADY_EXISTS',
  USER_INVALID_STATUS: 'USER_INVALID_STATUS',

  // ── Analytics module ────────────────────────────────────────────
  ANALYTICS_EVENT_NOT_FOUND: 'ANALYTICS_EVENT_NOT_FOUND',
  ANALYTICS_CLICKHOUSE_ERROR: 'ANALYTICS_CLICKHOUSE_ERROR',

  // ── Request signing (docs/api-conventions.md) — all map to 401 ──
  API_KEY_UNKNOWN: 'API_KEY_UNKNOWN',
  SIGNATURE_INVALID: 'SIGNATURE_INVALID',
  SIGNATURE_EXPIRED: 'SIGNATURE_EXPIRED',
  NONCE_REUSED: 'NONCE_REUSED',
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

/** HTTP status → stable machine-readable error code. */
export const HTTP_STATUS_TO_ERROR_CODE: Record<number, ErrorCode> = {
  400: ERROR_CODES.BAD_REQUEST,
  401: ERROR_CODES.UNAUTHORIZED,
  403: ERROR_CODES.FORBIDDEN,
  404: ERROR_CODES.NOT_FOUND,
  409: ERROR_CODES.CONFLICT,
  422: ERROR_CODES.UNPROCESSABLE,
  429: ERROR_CODES.RATE_LIMITED,
  500: ERROR_CODES.INTERNAL_ERROR,
  502: ERROR_CODES.BAD_GATEWAY,
  503: ERROR_CODES.SERVICE_UNAVAILABLE,
};

/**
 * HTTP status → gRPC status code (numeric values per the gRPC spec,
 * matching `@grpc/grpc-js` `status` — kept numeric so this package has
 * no grpc dependency).
 */
export const HTTP_STATUS_TO_GRPC_STATUS: Record<number, number> = {
  400: 3, // INVALID_ARGUMENT
  401: 16, // UNAUTHENTICATED
  403: 7, // PERMISSION_DENIED
  404: 5, // NOT_FOUND
  409: 6, // ALREADY_EXISTS
  422: 3, // INVALID_ARGUMENT
  429: 8, // RESOURCE_EXHAUSTED
  503: 14, // UNAVAILABLE
};
