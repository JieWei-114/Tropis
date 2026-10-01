import { createHash, createHmac } from 'crypto';

/**
 * Canonical string for HMAC request signing — MUST match the SDK
 * implementation in packages/sdk/src/signing/, the native signing service and
 * the spec in docs/api-conventions.md:
 *
 *   METHOD \n PATH \n X-Timestamp \n X-Nonce \n SHA256(body) as lowercase hex
 *
 * PATH is the full request path including the global prefix and query string
 * (e.g. /api/v1/track/secure), exactly as sent on the wire.
 */
export function buildCanonicalString(
  method: string,
  path: string,
  timestamp: string,
  nonce: string,
  body: Buffer | string,
): string {
  const bodyHash = createHash('sha256').update(body).digest('hex');
  return `${method.toUpperCase()}\n${path}\n${timestamp}\n${nonce}\n${bodyHash}`;
}

/** hex(HMAC-SHA256(secret, canonical)) */
export function computeSignature(secret: string, canonical: string): string {
  return createHmac('sha256', secret).update(canonical).digest('hex');
}
