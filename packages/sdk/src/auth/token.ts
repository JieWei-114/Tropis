/**
 * Browser token store — persists the JWT in localStorage and validates
 * the `exp` claim on read so expired tokens are evicted eagerly.
 */

const STORAGE_KEY = 'token';

export const setToken = (t: string): void => localStorage.setItem(STORAGE_KEY, t);
export const clearToken = (): void => localStorage.removeItem(STORAGE_KEY);

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
