/**
 * Browser token store — persists the JWT in localStorage and validates
 * the `exp` claim on read so expired tokens are evicted eagerly.
 */

const STORAGE_KEY = 'token';
const REFRESH_KEY = 'refresh_token';

export const setToken = (t: string): void => localStorage.setItem(STORAGE_KEY, t);
export const clearToken = (): void => localStorage.removeItem(STORAGE_KEY);

/**
 * Refresh token — opaque, longer-lived; used to mint a fresh access token when
 * the short-lived access token expires (see the refresh-on-401 flow in the
 * gRPC-Web/REST clients). Stored alongside the access token; the security
 * tradeoff is the same as the access token (XSS-exposable — httpOnly cookies
 * remain the stronger option). Kept opaque, so no exp parsing here.
 */
export const setRefreshToken = (t: string): void =>
  localStorage.setItem(REFRESH_KEY, t);
export const getRefreshToken = (): string | null =>
  localStorage.getItem(REFRESH_KEY);
export const clearRefreshToken = (): void =>
  localStorage.removeItem(REFRESH_KEY);

/** Clear both tokens (logout / refresh failure). */
export const clearTokens = (): void => {
  clearToken();
  clearRefreshToken();
};

/** Returns the stored token only if it exists and has not expired. */
export function getToken(): string | null {
  const token = localStorage.getItem(STORAGE_KEY);
  if (!token) return null;
  try {
    const payload = JSON.parse(atob(token.split('.')[1])) as { exp?: number };
    if (payload.exp && payload.exp * 1000 < Date.now()) {
      localStorage.removeItem(STORAGE_KEY); // expired — evict immediately
      return null;
    }
  } catch {
    // malformed token — treat as absent
    localStorage.removeItem(STORAGE_KEY);
    return null;
  }
  return token;
}
