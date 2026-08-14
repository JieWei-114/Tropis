/**
 * HMAC request signing for server-to-server REST calls.
 *
 * Implements the client side of the scheme in docs/api-conventions.md:
 *
 *   canonical = METHOD \n PATH \n X-Timestamp \n X-Nonce \n SHA256(body) hex
 *   X-Signature = hex(HMAC-SHA256(secret, canonical))
 *
 * PATH must be the full path including the /api prefix and any query string,
 * exactly as sent on the wire (e.g. /api/v1/track/secure).
 *
 * Uses WebCrypto (globalThis.crypto.subtle) so it runs in Node ≥ 20 without
 * dependencies.
 *
 * ⚠️ SECURITY: API secrets must NEVER be shipped to a browser — anything in
 * client-side JS is public. Use this only in trusted server environments
 * (backend jobs, partner integrations). Browsers authenticate with user JWTs.
 */

export interface SignRequestInput {
  /** HTTP method, e.g. 'POST' (case-insensitive). */
  method: string;
  /** Full request path incl. prefix + query string, e.g. '/api/v1/track/secure'. */
  path: string;
  /** Exact request body string (the same bytes that will be sent), '' for none. */
  body?: string;
  /** API key id — sent as X-Api-Key. */
  keyId: string;
  /** Shared secret for the key id. */
  secret: string;
  /** Override for tests: unix seconds. Defaults to now. */
  timestamp?: number;
  /** Override for tests: unique nonce. Defaults to crypto.randomUUID(). */
  nonce?: string;
}

export interface SignedHeaders {
  'X-Api-Key': string;
  'X-Timestamp': string;
  'X-Nonce': string;
  'X-Signature': string;
}

const encoder = new TextEncoder();

/**
 * WebCrypto handle: browsers and Node ≥ 19 expose globalThis.crypto;
 * older Node needs the explicit node:crypto webcrypto export.
 */
async function getCrypto(): Promise<Crypto> {
  const g = globalThis as { crypto?: Crypto };
  if (g.crypto?.subtle) return g.crypto;
  // @vite-ignore: only reached in Node < 19; browsers always have
  // globalThis.crypto, so bundlers must not try to resolve this.
  const mod = (await import(/* @vite-ignore */ 'node:crypto')) as unknown as {
    webcrypto: Crypto;
  };
  return mod.webcrypto;
}

function toHex(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

async function sha256Hex(data: string): Promise<string> {
  const c = await getCrypto();
  return toHex(await c.subtle.digest('SHA-256', encoder.encode(data)));
}

async function hmacSha256Hex(secret: string, data: string): Promise<string> {
  const c = await getCrypto();
  const key = await c.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return toHex(await c.subtle.sign('HMAC', key, encoder.encode(data)));
}

/** Builds the canonical string — must match the backend SignatureGuard. */
export async function buildCanonicalString(
  method: string,
  path: string,
  timestamp: string,
  nonce: string,
  body: string,
): Promise<string> {
  const bodyHash = await sha256Hex(body);
  return `${method.toUpperCase()}\n${path}\n${timestamp}\n${nonce}\n${bodyHash}`;
}

/** Returns the four signing headers for a request. */
export async function signRequest(
  input: SignRequestInput,
): Promise<SignedHeaders> {
  const timestamp = String(input.timestamp ?? Math.floor(Date.now() / 1000));
  const nonce = input.nonce ?? (await getCrypto()).randomUUID();
  const canonical = await buildCanonicalString(
    input.method,
    input.path,
    timestamp,
    nonce,
    input.body ?? '',
  );
  return {
    'X-Api-Key': input.keyId,
    'X-Timestamp': timestamp,
    'X-Nonce': nonce,
    'X-Signature': await hmacSha256Hex(input.secret, canonical),
  };
}

export interface SignedFetchOptions {
  keyId: string;
  secret: string;
  /** Custom fetch implementation (defaults to globalThis.fetch). */
  fetchImpl?: typeof fetch;
}

/**
 * Wraps fetch so every request is HMAC-signed. Body must be a string
 * (typically JSON.stringify(...)) so the signed bytes match the sent bytes.
 *
 *   const signedFetch = createSignedFetch({ keyId, secret });
 *   await signedFetch('http://localhost:3100/api/v1/track/secure', {
 *     method: 'POST',
 *     headers: { 'Content-Type': 'application/json' },
 *     body: JSON.stringify({ events }),
 *   });
 */
export function createSignedFetch(options: SignedFetchOptions): typeof fetch {
  const { keyId, secret, fetchImpl = fetch } = options;

  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(
      typeof input === 'string' || input instanceof URL
        ? String(input)
        : input.url,
    );
    const body = init?.body;
    if (body !== undefined && typeof body !== 'string') {
      throw new Error(
        'createSignedFetch: body must be a string so the signature covers the exact bytes sent',
      );
    }
    const headers = await signRequest({
      method: init?.method ?? 'GET',
      path: url.pathname + url.search,
      body: body ?? '',
      keyId,
      secret,
    });
    return fetchImpl(input, {
      ...init,
      headers: { ...(init?.headers as Record<string, string>), ...headers },
    });
  }) as typeof fetch;
}
