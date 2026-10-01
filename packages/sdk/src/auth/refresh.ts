/**
 * Access-token refresh. The refresh token lives in the httpOnly `tropis_rt`
 * cookie, scoped to /api/auth, which script cannot read: a refresh is a
 * bodyless POST /api/auth/refresh with credentials, and the server rotates
 * the cookie and answers with a new access token.
 *
 * Single-flight: concurrent 401s in one tab share one refresh, and the Web
 * Locks API serialises refreshes across tabs, so two tabs never present the
 * same rotating cookie at once.
 */

import { CLIENT_HEADER_VALUE, HEADERS } from '@tropis/shared';
import { clearToken, setToken } from './token';
import { resolveTraceparent, type TraceparentProvider } from '../trace/index';

/** Resolves to the new access token, or null when the session is gone. */
export type Refresher = () => Promise<string | null>;

export interface RefresherOptions {
  fetchImpl?: typeof fetch;
  traceparent?: TraceparentProvider;
  /** Abort a refresh that does not answer, so the cross-tab lock is released. */
  timeoutMs?: number;
}

const REFRESH_TIMEOUT_MS = 10_000;

const LOCK_NAME = 'tropis-auth-refresh';

/** Headers every cookie-authenticated auth endpoint requires. */
export function authEndpointHeaders(): Record<string, string> {
  return { [HEADERS.CLIENT]: CLIENT_HEADER_VALUE };
}

interface LockManagerLike {
  request<T>(name: string, callback: () => Promise<T>): Promise<T>;
}

function withLock<T>(run: () => Promise<T>): Promise<T> {
  const locks = (
    globalThis.navigator as { locks?: LockManagerLike } | undefined
  )?.locks;
  return locks ? locks.request(LOCK_NAME, run) : run();
}

export function createRefresher(
  restBaseUrl: string,
  options: RefresherOptions = {},
): Refresher {
  const { fetchImpl, traceparent, timeoutMs = REFRESH_TIMEOUT_MS } = options;
  let inFlight: Promise<string | null> | null = null;
  const url = `${restBaseUrl.replace(/\/$/, '')}/api/auth/refresh`;

  const run = async (): Promise<string | null> => {
    let res: Response;
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), timeoutMs);
    try {
      res = await (fetchImpl ?? fetch)(url, {
        method: 'POST',
        credentials: 'include',
        signal: abort.signal,
        headers: {
          ...authEndpointHeaders(),
          [HEADERS.TRACEPARENT]: resolveTraceparent(traceparent),
        },
      });
    } catch {
      // Network error or timeout: the session may still be valid; keep the token.
      return null;
    } finally {
      clearTimeout(timer);
    }
    if (res.status === 204 || res.status === 401 || res.status === 403) {
      clearToken();
      return null;
    }
    if (!res.ok) return null;
    const data = (await res.json().catch(() => ({}))) as {
      accessToken?: string;
    };
    if (!data.accessToken) {
      clearToken();
      return null;
    }
    setToken(data.accessToken);
    return data.accessToken;
  };

  return () => {
    inFlight ??= withLock(run).finally(() => {
      inFlight = null;
    });
    return inFlight;
  };
}
