/**
 * Typed fetch helpers for the REST endpoints (auth, multipart uploads, role
 * management, workflows, health) that are not RPC methods. Authenticated
 * requests refresh-on-401 and retry once.
 *
 * Auth endpoints run with `credentials: 'include'` and the x-tropis-client
 * header: the server keeps the refresh token in an httpOnly cookie scoped to
 * /api/auth and rejects cookie-authenticated calls without that header
 * (AUTH_CSRF_REJECTED). With `nativeSession`, a native shell sends
 * `x-tropis-client: native` without credentials instead, and login and the
 * OAuth exchange answer the refresh token in the body.
 */
import { HEADERS } from '@tropis/shared';
import {
  authEndpointHeaders,
  nativeEndpointHeaders,
  type Refresher,
} from '../auth/refresh';
import {
  isProblemBody,
  readApiError,
  type ProblemDetails,
} from '../errors/index';
import { resolveTraceparent, type TraceparentProvider } from '../trace/index';

export interface RestOptions {
  /** REST API origin, e.g. http://localhost:3100 (the SDK appends /api). */
  baseUrl: string;
  /** Returns the current bearer token, or null when unauthenticated. */
  getToken?: () => string | null;
  /** Refresh-on-401 hook (shared single-flight with the RPC client). */
  refresh?: Refresher;
  /** Per-request timeout. Defaults to REST_TIMEOUT_MS. */
  timeoutMs?: number;
  /**
   * Tenant sent as X-Tenant-ID. Required for calls made without a token
   * (login, sign-up); with a token the backend takes the token's tenant and
   * rejects a different one (TENANT_MISMATCH).
   */
  tenantId?: string;
  /** Active W3C traceparent per call; a fresh trace when it returns none. */
  traceparent?: TraceparentProvider;
  /** Native session flow: refresh token in the body, no cookie. */
  nativeSession?: boolean;
}

/**
 * Matches the RPC transport's default. Without a timeout a hung connection
 * never settles, so callers (e.g. the login button) spin forever with no error.
 */
const REST_TIMEOUT_MS = 10_000;

/**
 * Body of login and OAuth exchange. The browser gets the access token only
 * (the refresh token is the cookie); a native session also gets
 * `refreshToken`.
 */
export interface AccessTokenResponse {
  accessToken: string;
  refreshToken?: string;
}

export type OAuthProvider = 'google' | 'github';

export interface OnboardingWorkflow {
  workflowId: string;
  userId: string;
  /** 'RUNNING' | 'COMPLETED' | 'FAILED' | ... */
  status: string;
  /** ISO 8601 UTC, or null while unknown. */
  startTime: string | null;
  closeTime: string | null;
}

export interface OnboardingWorkflows {
  /** False when the workflow capability is disabled on the server. */
  available: boolean;
  summary: { running: number; completed: number };
  items: OnboardingWorkflow[];
}

/** One user's roles. */
export interface UserRoles {
  userId: string;
  roles: string[];
}

/** One page of GET /api/users/roles (AIP-158). */
export interface UserRolesPage {
  items: UserRoles[];
  /** Pass as `pageToken` to read the next page; empty on the last page. */
  nextPageToken: string;
  /** Users across all pages. */
  totalSize: number;
}

export interface UserRolesOptions {
  /** Maximum users per page; the server default (20, at most 100) when omitted. */
  pageSize?: number;
  /** `nextPageToken` of the previous page; omit for the first page. */
  pageToken?: string;
}

export interface HealthCheck {
  /** Capability name: documents, cache, messaging, ... */
  name: string;
  status: 'up' | 'down';
  /** Adapter behind the capability, when the server reported it. */
  adapter?: string;
  /** True when the capability is switched off (it still reports up). */
  disabled?: boolean;
}

export interface HealthStatus {
  /** `error` when a dependency the server cannot run without is down. */
  status: 'ok' | 'error';
  checks: HealthCheck[];
  /** Optional capabilities that are down. */
  degraded: string[];
}

export interface RestClient {
  /** POST /api/auth/login — sets the refresh cookie, returns the access token. */
  login(email: string, password: string): Promise<AccessTokenResponse>;
  /**
   * POST /api/auth/oauth/exchange — trades the one-time code of an OAuth
   * callback, with the PKCE verifier of the sign-in that produced it, for an
   * access token (and the refresh cookie).
   */
  exchangeOAuthCode(
    code: string,
    verifier: string,
  ): Promise<AccessTokenResponse>;
  /**
   * URL of GET /api/auth/{provider}, which starts an OAuth sign-in; a native
   * shell passes its custom-scheme `redirect` to be returned to.
   */
  oauthStartUrl(
    provider: OAuthProvider,
    challenge: string,
    redirect?: string,
  ): string;
  /**
   * POST /api/auth/logout — revokes the session and clears the cookie; a
   * native session posts /api/auth/native/logout with its refresh token.
   */
  logout(refreshToken?: string): Promise<void>;
  /** POST /api/users/:id/avatar — multipart upload, returns the avatar URL. */
  uploadAvatar(userId: string, file: File): Promise<string>;
  /** GET /api/users/roles — one page of user roles in the tenant (admin). */
  getUserRoles(options?: UserRolesOptions): Promise<UserRolesPage>;
  /** PATCH /api/users/:id/roles — replaces a user's roles (admin). */
  setUserRoles(
    id: string,
    roles: string[],
  ): Promise<{ id: string; roles: string[] }>;
  /** GET /api/workflows/onboarding — onboarding workflow summary. */
  listOnboardingWorkflows(): Promise<OnboardingWorkflows>;
  /** GET /api/health — every capability with its status and adapter. */
  getHealth(): Promise<HealthStatus>;
}

interface ProbeEntry {
  status?: unknown;
  adapter?: unknown;
  disabled?: unknown;
}

/** Health from either a 200 report (`details`) or a 503 problem (`checks`). */
function toHealth(body: unknown): HealthStatus | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const b = body as Record<string, unknown>;
  if (isProblemBody(b)) {
    const checks = (b as ProblemDetails).checks ?? [];
    return {
      status: 'error',
      checks: checks.map((c) => ({
        name: c.name,
        status: c.status === 'up' ? 'up' : 'down',
      })),
      degraded: [],
    };
  }
  if (typeof b.details !== 'object' || b.details === null) return undefined;
  const checks = Object.entries(b.details as Record<string, ProbeEntry>).map(
    ([name, p]): HealthCheck => {
      const check: HealthCheck = {
        name,
        status: p?.status === 'up' ? 'up' : 'down',
      };
      if (typeof p?.adapter === 'string') check.adapter = p.adapter;
      if (p?.disabled === true) check.disabled = true;
      return check;
    },
  );
  return {
    status: b.status === 'error' ? 'error' : 'ok',
    checks,
    degraded: Array.isArray(b.degraded)
      ? b.degraded.filter((d): d is string => typeof d === 'string')
      : [],
  };
}

export function createRestClient(options: RestOptions): RestClient {
  const {
    baseUrl,
    getToken,
    refresh,
    timeoutMs = REST_TIMEOUT_MS,
    tenantId,
    traceparent,
    nativeSession = false,
  } = options;
  const tenantHeaders: Record<string, string> = tenantId
    ? { [HEADERS.TENANT]: tenantId }
    : {};
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

  const traceHeaders = (): Record<string, string> => ({
    [HEADERS.TRACEPARENT]: resolveTraceparent(traceparent),
  });

  const bearer = (): Record<string, string> => {
    const token = getToken?.();
    return token ? { Authorization: `Bearer ${token}` } : {};
  };

  /** Authenticated fetch: on 401, refresh once and retry with the new token. */
  async function authedFetch(
    input: string,
    init: RequestInit = {},
  ): Promise<Response> {
    const trace = traceHeaders();
    const withAuth = (): RequestInit => ({
      ...init,
      headers: {
        ...trace,
        ...(init.headers as Record<string, string>),
        ...tenantHeaders,
        ...bearer(),
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

  async function json<T>(res: Response): Promise<T> {
    if (!res.ok) throw await readApiError(res);
    return (await res.json()) as T;
  }

  /** POST to an auth endpoint, in the cookie or the native session flow. */
  function authPost(path: string, body?: unknown): Promise<Response> {
    return timedFetch(`${apiBase}/auth/${path}`, {
      method: 'POST',
      credentials: nativeSession ? 'omit' : 'include',
      headers: {
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...traceHeaders(),
        ...tenantHeaders,
        ...(nativeSession ? nativeEndpointHeaders() : authEndpointHeaders()),
        ...bearer(),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }

  return {
    async login(email, password) {
      // RFC 9457 problem details carry the reason; readApiError turns them
      // into an error whose message is fit to show (field reasons first).
      return json<AccessTokenResponse>(
        await authPost('login', { email, password }),
      );
    },

    async exchangeOAuthCode(code, verifier) {
      return json<AccessTokenResponse>(
        await authPost('oauth/exchange', { code, verifier }),
      );
    },

    oauthStartUrl(provider, challenge, redirect) {
      const query = new URLSearchParams({ challenge });
      if (redirect) query.set('redirect', redirect);
      return `${apiBase}/auth/${provider}?${query.toString()}`;
    },

    async logout(refreshToken) {
      // Best effort: a network failure must still let the caller clear the
      // local session rather than trap the user signed in.
      const sent = nativeSession
        ? authPost('native/logout', refreshToken ? { refreshToken } : {})
        : authPost('logout');
      await sent.catch(() => undefined);
    },

    async uploadAvatar(userId, file) {
      const form = new FormData();
      form.append('file', file);
      const res = await authedFetch(
        `${apiBase}/users/${encodeURIComponent(userId)}/avatar`,
        { method: 'POST', body: form },
      );
      return (await json<{ url: string }>(res)).url;
    },

    async getUserRoles({ pageSize, pageToken }: UserRolesOptions = {}) {
      const query = new URLSearchParams();
      if (pageSize !== undefined) query.set('pageSize', String(pageSize));
      if (pageToken) query.set('pageToken', pageToken);
      const qs = query.toString();
      return json<UserRolesPage>(
        await authedFetch(`${apiBase}/users/roles${qs ? `?${qs}` : ''}`),
      );
    },

    async setUserRoles(id, roles) {
      return json<{ id: string; roles: string[] }>(
        await authedFetch(`${apiBase}/users/${encodeURIComponent(id)}/roles`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ roles }),
        }),
      );
    },

    async listOnboardingWorkflows() {
      return json<OnboardingWorkflows>(
        await authedFetch(`${apiBase}/workflows/onboarding`),
      );
    },

    async getHealth() {
      const res = await timedFetch(`${apiBase}/health`, {
        headers: traceHeaders(),
      });
      // A 503 still describes every capability; only an unreadable body is
      // an error.
      const body: unknown = await res
        .clone()
        .json()
        .catch(() => undefined);
      const health = toHealth(body);
      if (health) return health;
      throw await readApiError(res);
    },
  };
}
