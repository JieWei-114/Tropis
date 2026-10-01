import type { ErrorCode } from './catalog';

/** One invalid input field (google.rpc.BadRequest.FieldViolation). */
export interface FieldViolation {
  /** Dotted path of the field, e.g. `address.city`; empty for the body. */
  field: string;
  description: string;
}

/** Status of one health probe, as reported in a failed health check. */
export interface HealthCheckStatus {
  name: string;
  status: 'up' | 'down';
}

/**
 * RFC 9457 problem details, the body of every REST error
 * (`Content-Type: application/problem+json`). Members after `instance` are
 * extension members defined by this API.
 */
export interface ProblemDetails {
  /** `https://errors.tropis.dev/<code-kebab>` (see catalog.ts). */
  type: string;
  /** The catalog `publicMessage`. */
  title: string;
  status: number;
  /** Occurrence-specific, safe explanation. */
  detail?: string;
  /** Path of the request that failed. */
  instance: string;
  code: ErrorCode;
  /** W3C trace id of the request; equals the `x-request-id` header. */
  traceId: string;
  retryable: boolean;
  /** Present for VALIDATION_FAILED and other field-level errors. */
  errors?: FieldViolation[];
  /** Present on a failed health check. */
  checks?: HealthCheckStatus[];
}
