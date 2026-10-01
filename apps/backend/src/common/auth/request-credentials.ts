import {
  bearerFromHeader,
  type Principal,
  type TokenVerifier,
} from './token-verifier.port';

export interface RequestCredentials {
  token?: string;
  principal?: Principal;
  error?: unknown;
}

interface CredentialCarrier {
  headers: Record<string, string | string[] | undefined>;
  [credentialsKey]?: Promise<RequestCredentials>;
}

const credentialsKey = Symbol('requestCredentials');

/**
 * Verifies the request's bearer token once and memoizes the outcome on the
 * request, so the tenant middleware and the auth guard share one
 * verification. Never rejects.
 */
export function requestCredentials(
  req: object,
  verifier: TokenVerifier,
): Promise<RequestCredentials> {
  const carrier = req as CredentialCarrier;
  carrier[credentialsKey] ??= (async () => {
    const raw = carrier.headers?.authorization;
    const token = bearerFromHeader(Array.isArray(raw) ? raw[0] : raw);
    if (!token) return {};
    try {
      return { token, principal: await verifier.verify(token) };
    } catch (error) {
      return { token, error };
    }
  })();
  return carrier[credentialsKey];
}
