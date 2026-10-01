/**
 * Access-token store, in memory only. The token never touches
 * localStorage or sessionStorage, so script injected into the page cannot
 * read a token that outlives the tab; the session survives a reload through
 * the httpOnly refresh cookie instead (restoreSession in api.ts).
 */

export type TokenListener = (token: string | null) => void;

let accessToken: string | null = null;
const listeners = new Set<TokenListener>();

function notify(): void {
  for (const listener of listeners) {
    try {
      listener(accessToken);
    } catch {
      /* a listener must not break the store */
    }
  }
}

export function setToken(token: string): void {
  if (token === accessToken) return;
  accessToken = token;
  notify();
}

export function clearToken(): void {
  if (accessToken === null) return;
  accessToken = null;
  notify();
}

function isExpired(token: string): boolean {
  try {
    const payload = token.split('.')[1] ?? '';
    const json = atob(payload.replace(/-/g, '+').replace(/_/g, '/'));
    const { exp } = JSON.parse(json) as { exp?: number };
    return typeof exp === 'number' && exp * 1000 < Date.now();
  } catch {
    return true;
  }
}

/**
 * The current access token, or null when there is none or it has expired.
 * An expired token stays stored: the next call answers 401, the client
 * refreshes, and only a failed refresh clears it.
 */
export function getToken(): string | null {
  if (!accessToken || isExpired(accessToken)) return null;
  return accessToken;
}

/** Calls `listener` on every change of the stored token; returns the unsubscribe. */
export function onTokenChange(listener: TokenListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** localStorage keys older SDK versions stored the tokens under. */
export const LEGACY_TOKEN_KEYS = ['token', 'refresh_token'] as const;

/** Removes tokens an older SDK version left in localStorage. */
export function clearLegacyTokens(): void {
  try {
    for (const key of LEGACY_TOKEN_KEYS)
      globalThis.localStorage?.removeItem(key);
  } catch {
    /* storage unavailable */
  }
}
