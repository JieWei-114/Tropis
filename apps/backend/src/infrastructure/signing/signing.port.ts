import type { HealthCheckable } from '../capability';

/**
 * Signing — HMAC-SHA256 request signatures (docs/api-conventions.md):
 *
 *   canonical = METHOD \n PATH \n timestamp \n nonce \n SHA256(body) hex
 *   signature = hex(HMAC-SHA256(secret, canonical))
 *
 * The port takes the request fields rather than a prebuilt canonical string
 * because the native adapter's service builds the canonical string itself
 * and resolves the secret from `keyId`; the in-process adapter uses `secret`.
 * Nonce replay protection is not part of signing (the caller uses dedup).
 */
export const SIGNING = Symbol('SIGNING');

export interface SignatureInput {
  method: string;
  /** Full request path including the global prefix and query string. */
  path: string;
  /** Unix seconds, exactly as sent in X-Timestamp. */
  timestamp: string;
  nonce: string;
  /** Exact raw request bytes; empty for no body. */
  body: Buffer;
  keyId: string;
}

export interface SigningPort extends HealthCheckable {
  /** Lowercase hex signature for the request. */
  sign(input: SignatureInput, secret: string): Promise<string>;
  /** Constant-time check of `signature` against the request. */
  verify(
    input: SignatureInput,
    signature: string,
    secret: string,
  ): Promise<boolean>;
}

export const SIGNING_ADAPTERS = ['inprocess', 'native'] as const;
export type SigningAdapterName = (typeof SIGNING_ADAPTERS)[number];
