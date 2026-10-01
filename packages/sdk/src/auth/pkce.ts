/**
 * OAuth sign-in binding (PKCE S256, RFC 7636). The browser that starts a
 * sign-in keeps a random verifier and sends only its SHA-256 challenge; the
 * one-time code is exchanged together with the verifier, so a code captured
 * or planted in another browser cannot be redeemed.
 *
 * Needs WebCrypto (crypto.subtle), which browsers expose in secure contexts
 * only: https origins, http://localhost and the native shells' https scheme.
 */

/** sessionStorage key of the verifier between redirect and callback. */
export const OAUTH_VERIFIER_KEY = 'tropis_oauth_verifier';

function base64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/** 32 random bytes as base64url: 43 characters from the unreserved set. */
export function createCodeVerifier(): string {
  const bytes = new Uint8Array(32);
  globalThis.crypto.getRandomValues(bytes);
  return base64Url(bytes);
}

/** base64url(SHA-256(verifier)). */
export async function codeChallenge(verifier: string): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    throw new Error(
      'OAuth sign-in needs a secure context (https or localhost) for WebCrypto',
    );
  }
  const digest = await subtle.digest(
    'SHA-256',
    new TextEncoder().encode(verifier),
  );
  return base64Url(new Uint8Array(digest));
}

function storage(): Storage | undefined {
  try {
    return globalThis.sessionStorage;
  } catch {
    return undefined;
  }
}

/** Creates and stores a verifier; resolves to its challenge. */
export async function beginPkce(): Promise<string> {
  const verifier = createCodeVerifier();
  const challenge = await codeChallenge(verifier);
  const store = storage();
  if (!store) throw new Error('OAuth sign-in needs sessionStorage');
  store.setItem(OAUTH_VERIFIER_KEY, verifier);
  return challenge;
}

/** The stored verifier, removed so it can be used once; null when none. */
export function takePkceVerifier(): string | null {
  const store = storage();
  if (!store) return null;
  const verifier = store.getItem(OAUTH_VERIFIER_KEY);
  store.removeItem(OAUTH_VERIFIER_KEY);
  return verifier;
}
