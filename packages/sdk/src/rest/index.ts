/**
 * Typed fetch helpers for REST endpoints (auth + multipart uploads) that don't
 * go through gRPC-Web. Authenticated requests refresh-on-401 and retry once.
 */

import type { Refresher } from '../auth/refresh';

export interface RestOptions {
  /** REST API origin, e.g. http://localhost:3100 (the SDK appends /api). */
  baseUrl: string;
  /** Returns the current bearer token, or null when unauthenticated. */
  getToken?: () => string | null;
  /** Refresh-on-401 hook (shared single-flight with the gRPC client). */
  refresh?: Refresher;
  /** Per-request timeout. Defaults to REST_TIMEOUT_MS. */
  timeoutMs?: number;
}

/**
 * Matches the gRPC transport's default. Without a timeout a hung connection
 * never settles, so callers (e.g. the login button) spin forever with no error.
 */
const REST_TIMEOUT_MS = 10_000;

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
}

export interface RestClient {
  /** POST /api/auth/login — returns the access + refresh token pair. */
  login(email: string, password: string): Promise<AuthTokens>;
  /** POST /api/auth/logout — revoke the current access + refresh tokens. */
  logout(refreshToken?: string): Promise<void>;
  /** POST /api/users/:id/avatar — multipart upload, returns the avatar URL. */
  uploadAvatar(userId: string, file: File): Promise<string>;
}

export function createRestClient(options: RestOptions): RestClient {
  const { baseUrl, getToken, refresh, timeoutMs = REST_TIMEOUT_MS } = options;
  const apiBase = `${baseUrl.replace(/\/$/, '')}/api`;

  /** fetch with a hard deadline; aborts instead of hanging indefinitely. */
  async function timedFetch(
    input: string,
    init: RequestInit = {},
  ): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(input, { ...init, signal: controller.signal });
    } catch (err) {
      if ((err as Error).name === 'AbortError') {
        throw new Error(`Request timed out after ${timeoutMs}ms: ${input}`);
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  const authHeaders = (): Record<string, string> => {
    const token = getToken?.();
    return token ? { Authorization: `Bearer ${token}` } : {};
  };

  /** Authenticated fetch: on 401, refresh once and retry with the new token. */
  async function authedFetch(
    input: string,
    init: RequestInit,
  ): Promise<Response> {
    const withAuth = (): RequestInit => ({
      ...init,
      headers: {
        ...(init.headers as Record<string, string>),
        ...authHeaders(),
      },
    });
    let res = await timedFetch(input, withAuth());
    if (res.status === 401 && refresh) {
      const token = await refresh();
      // The retry gets its own fresh deadline.
      if (token) res = await timedFetch(input, withAuth());
    }
    return res;
  }

  return {
    async login(email, password): Promise<AuthTokens> {
      const res = await timedFetch(`${apiBase}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      if (!res.ok) {
        // Surface the server's reason (e.g. "password must be longer than or
        // equal to 8 characters") instead of a bare status code.
        const detail = await res
          .json()
          .then((b: { message?: unknown; code?: unknown }) => {
            const msg = Array.isArray(b?.message)
              ? (b.message as string[]).join('; ')
              : typeof b?.message === 'string'
                ? b.message
                : '';
            const code = typeof b?.code === 'string' ? b.code : '';
            return [code, msg].filter(Boolean).join(': ');
          })
          .catch(() => '');
        throw new Error(
          detail ? `Login failed: ${detail}` : `Login failed: ${res.status}`,
        );
      }
      return (await res.json()) as AuthTokens;
    },

    async logout(refreshToken?: string): Promise<void> {
      await authedFetch(`${apiBase}/auth/logout`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(refreshToken ? { refreshToken } : {}),
      }).catch(() => undefined);
    },

    async uploadAvatar(userId: string, file: File): Promise<string> {
      const form = new FormData();
      form.append('file', file);
      const res = await authedFetch(`${apiBase}/users/${userId}/avatar`, {
        method: 'POST',
        body: form,
      });
      if (!res.ok) throw new Error(`Avatar upload failed: ${res.status}`);
      const data = (await res.json()) as { url: string };
      return data.url;
    },
  };
}
