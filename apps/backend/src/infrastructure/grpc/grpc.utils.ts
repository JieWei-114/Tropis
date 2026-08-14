import { RpcException } from '@nestjs/microservices';
import { status as GrpcStatus } from '@grpc/grpc-js';

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
