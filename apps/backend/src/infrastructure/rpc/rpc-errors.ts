import { create } from '@bufbuild/protobuf';
import { Code, ConnectError } from '@connectrpc/connect';
import {
  ERROR_DOMAIN,
  errorCodeForRpcCode,
  RPC_CODES,
  type ErrorCode,
  type FieldViolation,
} from '@tropis/shared';
import { normalizeError } from '../../common/errors';
import {
  BadRequestSchema,
  ErrorInfoSchema,
} from '../../gen/google/rpc/error_details_pb';

/** A detail as ConnectError's constructor accepts it. */
type OutgoingDetail = NonNullable<
  ConstructorParameters<typeof ConnectError>[3]
>[number];

/**
 * Maps any thrown value to a ConnectError in the AIP-193 shape:
 *
 * - status: the catalog entry's `rpcCode`;
 * - message: the safe `detail` when the thrower gave one, else the catalog
 *   `publicMessage` (never an internal error's own message);
 * - details: `google.rpc.ErrorInfo { reason: <catalog code>, domain:
 *   "tropis", metadata: { retryable, ... } }`, plus `google.rpc.BadRequest`
 *   with the field violations of a validation error.
 *
 * A ConnectError a handler threw keeps its code and message; it gains the
 * ErrorInfo for its code's generic catalog entry when it carries none.
 * The trace id is added by the correlation interceptor as the `trace-id`
 * header/trailer.
 */
export interface RpcErrorMapping {
  error: ConnectError;
  /** The thrown value was not anticipated by its thrower (log it in full). */
  unexpected: boolean;
  code: ErrorCode;
}

function errorInfo(
  code: ErrorCode,
  retryable: boolean,
  metadata: Record<string, string> = {},
) {
  return {
    desc: ErrorInfoSchema,
    value: create(ErrorInfoSchema, {
      reason: code,
      domain: ERROR_DOMAIN,
      metadata: { ...metadata, retryable: String(retryable) },
    }),
  };
}

function badRequest(violations: FieldViolation[]) {
  return {
    desc: BadRequestSchema,
    value: create(BadRequestSchema, {
      fieldViolations: violations.map((v) => ({
        field: v.field,
        description: v.description,
      })),
    }),
  };
}

function hasErrorInfo(err: ConnectError): boolean {
  return err.details.some((d) =>
    'desc' in d
      ? d.desc.typeName === ErrorInfoSchema.typeName
      : d.type === ErrorInfoSchema.typeName,
  );
}

const RETRYABLE_RPC_CODES = new Set<Code>([
  Code.Unavailable,
  Code.ResourceExhausted,
  Code.Aborted,
  Code.DeadlineExceeded,
]);

export function mapRpcError(err: unknown): RpcErrorMapping {
  if (err instanceof ConnectError) {
    const code = errorCodeForRpcCode(err.code);
    if (!hasErrorInfo(err)) {
      err.details.push(errorInfo(code, RETRYABLE_RPC_CODES.has(err.code)));
    }
    return { error: err, unexpected: false, code };
  }

  const n = normalizeError(err);
  const details: OutgoingDetail[] = [
    errorInfo(n.code, n.definition.retryable, n.metadata),
  ];
  if (n.fieldViolations.length) details.push(badRequest(n.fieldViolations));
  const error = new ConnectError(
    n.detail ?? n.definition.publicMessage,
    RPC_CODES[n.definition.rpcCode] as Code,
    undefined,
    details,
    err,
  );
  return { error, unexpected: n.unexpected, code: n.code };
}

/** mapRpcError(err).error. */
export function toConnectError(err: unknown): ConnectError {
  return mapRpcError(err).error;
}

/** Message of a thrown value without the `[code]` prefix ConnectError adds. */
export function errorMessage(err: unknown): string {
  if (err instanceof ConnectError) return err.rawMessage;
  return err instanceof Error ? err.message : String(err);
}
