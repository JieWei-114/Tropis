import { HttpException } from '@nestjs/common';
import { RpcException } from '@nestjs/microservices';
import { status as GrpcStatus } from '@grpc/grpc-js';
import { HTTP_STATUS_TO_GRPC_STATUS } from '@tropis/shared';

/**
 * Normalizes any thrown error into an RpcException with a proper gRPC status
 * and a readable message. Domain code throws transport-neutral HttpExceptions
 * (e.g. ConflictException); this maps them so gRPC callers get a real code +
 * message instead of a generic UNKNOWN "Internal server error".
 *
 * When the thrower passed a machine code (e.g. `{ code: 'USER_ALREADY_EXISTS',
 * message: '…' }`), it is prefixed so the caller sees both.
 */
export function toRpcException(err: unknown): RpcException {
  if (err instanceof RpcException) return err;

  if (err instanceof HttpException) {
    const httpStatus = err.getStatus();
    const grpcCode =
      HTTP_STATUS_TO_GRPC_STATUS[httpStatus] ?? GrpcStatus.INTERNAL;
    const res = err.getResponse();
    let message = err.message;
    let code: string | undefined;
    if (typeof res === 'object' && res !== null) {
      const b = res as { message?: unknown; code?: unknown };
      if (typeof b.code === 'string') code = b.code;
      message = Array.isArray(b.message)
        ? (b.message as string[]).join('; ')
        : String(b.message ?? err.message);
    } else if (typeof res === 'string') {
      message = res;
    }
    return new RpcException({
      code: grpcCode,
      message: code ? `${code}: ${message}` : message,
    });
  }

  return new RpcException({
    code: GrpcStatus.INTERNAL,
    message: err instanceof Error ? err.message : 'Internal error',
  });
}

// With @GrpcMethod, the second handler parameter is the raw grpc Metadata object.
// Metadata has a .get(key) method returning string[] | Buffer[] — no decorator needed.
function isGrpcMetadata(
  metadata: unknown,
): metadata is { get(key: string): unknown } {
  return (
    typeof metadata === 'object' &&
    metadata !== null &&
    'get' in metadata &&
    typeof (metadata as { get?: unknown }).get === 'function'
  );
}

export function resolveAuthorizationHeader(
  metadata: unknown,
): string | undefined {
  if (!isGrpcMetadata(metadata)) return undefined;

  const raw = metadata.get('authorization');
  const value = Array.isArray(raw) ? raw[0] : raw;

  let tokenString: string | undefined;
  if (typeof value === 'string') {
    tokenString = value;
  } else if (value instanceof Buffer) {
    tokenString = value.toString('utf8');
  }

  if (!tokenString) return undefined;
  return tokenString.replace(/^Bearer\s+/i, '').trim() || undefined;
}

/**
 * Extracts a JWT from a gRPC call. Priority:
 *   1. Authorization metadata header (standard)
 *   2. `token` field in the request body (backward-compat with old clients)
 */
export function extractToken(data: unknown, metadata: unknown): string {
  const headerToken = resolveAuthorizationHeader(metadata);
  if (headerToken) return headerToken;

  const token = (data as Record<string, unknown>)?.['token'];
  if (typeof token === 'string' && token) return token;

  throw new RpcException({
    code: GrpcStatus.UNAUTHENTICATED,
    message: 'Missing authorization token',
  });
}
