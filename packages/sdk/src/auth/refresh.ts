/**
 * Access-token refresh — the client half of the short-access-token + rotating-
 * refresh-token scheme. When a request comes back 401/Unauthenticated, the
 * gRPC-Web and REST clients call the shared refresher below to mint a new
 * access token and retry once.
 *
 * Single-flight: concurrent 401s (a page firing several calls at once) share
 * ONE in-flight refresh instead of stampeding the /auth/refresh endpoint.
 */

import {
  getRefreshToken,
  setToken,
  setRefreshToken,
  clearTokens,
} from './token';

export type Refresher = () => Promise<string | null>;

/**
 * Build a single-flight refresher bound to the REST API origin.
 * Returns the new access token, or null when refresh is impossible/failed
 * (in which case both tokens are cleared → the app should redirect to login).
 */
export function createRefresher(
  restBaseUrl: string,
  fetchImpl: typeof fetch = fetch,
): Refresher {
  let inFlight: Promise<string | null> | null = null;
  const url = `${restBaseUrl.replace(/\/$/, '')}/api/auth/refresh`;

  const run = async (): Promise<string | null> => {
    const refreshToken = getRefreshToken();
    if (!refreshToken) return null;
    try {
      const res = await fetchImpl(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken }),
      });
      if (!res.ok) {
        clearTokens(); // refresh token rejected/expired → force re-login
        return null;
      }
      const data = (await res.json()) as {
        accessToken?: string;
        refreshToken?: string;
      };
      if (!data.accessToken) {
        clearTokens();
        return null;
      }
      setToken(data.accessToken);
      if (data.refreshToken) setRefreshToken(data.refreshToken); // rotation
      return data.accessToken;
    } catch {
      // Network error — don't nuke tokens; the caller retries later.
      return null;
    }
  };

  return () => {
    inFlight ??= run().finally(() => {
      inFlight = null;
    });
    return inFlight;
  };
}
