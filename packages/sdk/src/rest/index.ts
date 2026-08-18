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
}

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
  const { baseUrl, getToken, refresh } = options;
  const apiBase = `${baseUrl.replace(/\/$/, '')}/api`;

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
      headers: { ...(init.headers as Record<string, string>), ...authHeaders() },
    });
    let res = await fetch(input, withAuth());
    if (res.status === 401 && refresh) {
      const token = await refresh();
      if (token) res = await fetch(input, withAuth()); // retry once
    }
    return res;
  }

  return {
    async login(email, password): Promise<AuthTokens> {
      const res = await fetch(`${apiBase}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      if (!res.ok) throw new Error(`Login failed: ${res.status}`);
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
