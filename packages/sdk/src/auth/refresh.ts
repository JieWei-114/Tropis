/**
 * Access-token refresh, in one of two session modes:
 *   - cookie (browser): the refresh token lives in the httpOnly `tropis_rt`
 *     cookie, scoped to /api/auth, which script cannot read; a refresh is a
 *     bodyless POST /api/auth/refresh with credentials, and the server
 *     rotates the cookie and answers with a new access token.
 *   - native (a SecureTokenStore is given): the shell keeps the refresh
 *     token in OS secure storage and posts it to /api/auth/native/refresh
 *     with `x-tropis-client: native`; the rotated token replaces it.
 *
 * Single-flight: concurrent 401s in one tab share one refresh, and the Web
 * Locks API serialises refreshes across tabs, so two tabs never present the
 * same rotating cookie at once.
 */

import {
  CLIENT_HEADER_VALUE,
  HEADERS,
  NATIVE_CLIENT_HEADER_VALUE,
} from '@tropis/shared';
import { clearToken, setToken } from './token';
import type { SecureTokenStore } from './session-store';
import { resolveTraceparent, type TraceparentProvider } from '../trace/index';

/** Resolves to the new access token, or null when the session is gone. */
export type Refresher = () => Promise<string | null>;

export interface RefresherOptions {
  fetchImpl?: typeof fetch;
  traceparent?: TraceparentProvider;
  /** Abort a refresh that does not answer, so the cross-tab lock is released. */
  timeoutMs?: number;
  /** Native session mode: the refresh token lives here instead of a cookie. */
  store?: SecureTokenStore;
}

const REFRESH_TIMEOUT_MS = 10_000;

const LOCK_NAME = 'tropis-auth-refresh';

/** Headers every cookie-authenticated auth endpoint requires. */
export function authEndpointHeaders(): Record<string, string> {
  return { [HEADERS.CLIENT]: CLIENT_HEADER_VALUE };
}

/** Headers that select the native session flow. */
export function nativeEndpointHeaders(): Record<string, string> {
  return { [HEADERS.CLIENT]: NATIVE_CLIENT_HEADER_VALUE };
}

async function quietly<T>(run: () => Promise<T>): Promise<T | undefined> {
  try {
    return await run();
  } catch {
    return undefined;
  }
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
  const {
    fetchImpl,
    traceparent,
    timeoutMs = REFRESH_TIMEOUT_MS,
    store,
  } = options;
  let inFlight: Promise<string | null> | null = null;
  const base = `${restBaseUrl.replace(/\/$/, '')}/api/auth`;

  const post = async (url: string, init: RequestInit) => {
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), timeoutMs);
    try {
      return await (fetchImpl ?? fetch)(url, {
        ...init,
        method: 'POST',
        signal: abort.signal,
      });
    } catch {
      return undefined;
    } finally {
      clearTimeout(timer);
    }
  };

  const endSession = async (): Promise<null> => {
    if (store) await quietly(() => store.clear());
    clearToken();
    return null;
  };

  const run = async (): Promise<string | null> => {
    let res: Response | undefined;
    const trace = { [HEADERS.TRACEPARENT]: resolveTraceparent(traceparent) };
    if (store) {
      const refreshToken = await quietly(() => store.get());
      if (!refreshToken) return endSession();
      res = await post(`${base}/native/refresh`, {
        credentials: 'omit',
        headers: {
          ...nativeEndpointHeaders(),
          ...trace,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ refreshToken }),
      });
    } else {
      res = await post(`${base}/refresh`, {
        credentials: 'include',
        headers: { ...authEndpointHeaders(), ...trace },
      });
    }
    // Network error or timeout: the session may still be valid; keep it.
    if (!res) return null;
    if (
      res.status === 204 ||
      res.status === 401 ||
      res.status === 403 ||
      (store && res.status === 400)
    ) {
      return endSession();
    }
    if (!res.ok) return null;
    const data = (await res.json().catch(() => ({}))) as {
      accessToken?: string;
      refreshToken?: string;
    };
    if (!data.accessToken || (store && !data.refreshToken)) {
      return endSession();
    }
    // The server has already rotated the token: if the new one cannot be
    // stored, the stored one is revoked, so the session ends now rather than
    // on the next refresh.
    if (store) {
      try {
        await store.set(data.refreshToken!);
      } catch {
        return endSession();
      }
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
