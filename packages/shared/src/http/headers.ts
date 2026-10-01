/**
 * HTTP header and RPC metadata names every contract shares. Lowercase, as
 * HTTP/2 and gRPC metadata carry them; HTTP/1.1 header names are
 * case-insensitive, so the same constant works on every transport.
 */
export const HEADERS = {
  /** Tenant a call without a token acts for (docs/api-conventions.md). */
  TENANT: 'x-tenant-id',
  /** W3C Trace Context parent. */
  TRACEPARENT: 'traceparent',
  /** W3C Trace Context vendor state. */
  TRACESTATE: 'tracestate',
  /** Trace id of the request, echoed on every REST response. */
  REQUEST_ID: 'x-request-id',
  /** Trace id of the request, echoed on every RPC response. */
  TRACE_ID: 'trace-id',
  /** Seconds to wait before retrying a 429 or 503. */
  RETRY_AFTER: 'retry-after',
  /**
   * Marks a request as sent by a first-party client; required by the
   * cookie-authenticated auth endpoints as a CSRF defence.
   */
  CLIENT: 'x-tropis-client',
  /** Request signing (HMAC) headers. */
  API_KEY: 'x-api-key',
  TIMESTAMP: 'x-timestamp',
  NONCE: 'x-nonce',
  SIGNATURE: 'x-signature',
  /** Service-to-service token on the internal RPC tier. */
  SERVICE_TOKEN: 'x-service-token',
} as const;

export type HeaderName = (typeof HEADERS)[keyof typeof HEADERS];

/** The value first-party clients send in the `x-tropis-client` header. */
export const CLIENT_HEADER_VALUE = '1';
