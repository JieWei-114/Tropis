import { HttpException } from '@nestjs/common';
import {
  ERROR_CATALOG,
  type ErrorCode,
  type ErrorDefinition,
  type FieldViolation,
} from '@tropis/shared';

export interface AppErrorOptions {
  /** Occurrence-specific explanation; must be safe to show a caller. */
  detail?: string;
  fieldViolations?: FieldViolation[];
  /** The underlying error; logged, never sent. */
  cause?: unknown;
  /** Safe key/value context, sent as google.rpc.ErrorInfo metadata. */
  metadata?: Record<string, string>;
}

/**
 * The error business code throws. Its code selects a catalog entry
 * (packages/shared/src/errors/catalog.ts), which fixes the HTTP status, RPC
 * code, retryability and public message; every transport renders it from
 * there.
 *
 * It extends HttpException so code paths that only understand Nest's
 * exceptions (the WebSocket filter, a test app without the global filter)
 * still answer with the right status.
 */
export class AppError extends HttpException {
  readonly code: ErrorCode;
  readonly definition: ErrorDefinition;
  readonly detail?: string;
  readonly fieldViolations: FieldViolation[];
  readonly metadata: Record<string, string>;

  constructor(code: ErrorCode, options: AppErrorOptions = {}) {
    const definition = ERROR_CATALOG[code];
    super(
      { code, message: options.detail ?? definition.publicMessage },
      definition.httpStatus,
      options.cause === undefined ? undefined : { cause: options.cause },
    );
    this.name = 'AppError';
    this.code = code;
    this.definition = definition;
    this.detail = options.detail;
    this.fieldViolations = options.fieldViolations ?? [];
    this.metadata = options.metadata ?? {};
  }

  get httpStatus(): number {
    return this.definition.httpStatus;
  }

  get retryable(): boolean {
    return this.definition.retryable;
  }

  /** VALIDATION_FAILED carrying one violation per invalid field. */
  static validation(
    fieldViolations: FieldViolation[],
    detail?: string,
  ): AppError {
    return new AppError('VALIDATION_FAILED', { fieldViolations, detail });
  }
}

export function isAppError(value: unknown): value is AppError {
  return value instanceof AppError;
}

/** AppError, or anything shaped like one (another copy of this module). */
export function isAppErrorLike(
  value: unknown,
): value is { code: ErrorCode; name: string } {
  return (
    value instanceof AppError ||
    (typeof value === 'object' &&
      value !== null &&
      (value as { name?: unknown }).name === 'AppError' &&
      typeof (value as { code?: unknown }).code === 'string')
  );
}
