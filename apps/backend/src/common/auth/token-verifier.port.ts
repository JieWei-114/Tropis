import type { TenantId } from '../keyspace';

export const TOKEN_VERIFIER = Symbol('TOKEN_VERIFIER');

/** The caller behind an access token that passed every check. */
export interface Principal {
  userId: string;
  email: string;
  roles: string[];
  tenantId: TenantId;
  jti: string;
  /** Expiry, epoch seconds. */
  exp: number;
}

/**
 * The single access-token check shared by REST guards, the RPC server and
 * the WebSocket gateway: signature and expiry, revocation, account status
 * and tenant membership. Rejects with an AppError (AUTH_TOKEN_INVALID,
 * AUTH_TOKEN_REVOKED, AUTH_ACCOUNT_INACTIVE, or SERVICE_UNAVAILABLE when a
 * store the check needs is down).
 */
export interface TokenVerifier {
  verify(token: string): Promise<Principal>;
}

/** Bearer token from an Authorization header value, without the scheme. */
export function bearerFromHeader(
  raw: string | undefined | null,
): string | undefined {
  if (!raw) return undefined;
  const match = /^Bearer\s+(.+)$/i.exec(raw.trim());
  return match?.[1].trim() || undefined;
}
