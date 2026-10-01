/**
 * High-level API facade — wraps the generated connect-es clients in a flat,
 * domain-typed function surface so callers never touch proto messages or
 * transport details.
 */

import { timestampMs, type Timestamp } from '@bufbuild/protobuf/wkt';
import { createSdk, type Sdk } from './client/index';
import {
  createRestClient,
  type HealthStatus,
  type OAuthProvider,
  type OnboardingWorkflows,
  type RestClient,
} from './rest/index';
import {
  clearLegacyTokens,
  clearToken,
  getToken as getStoredToken,
  setToken,
} from './auth/token';
import { createRefresher } from './auth/refresh';
import { beginPkce, takePkceVerifier } from './auth/pkce';
import type { UserResponse } from './gen/user/v1/user_pb';
import type { EventResponse } from './gen/analytics/v1/analytics_pb';
import type { TraceparentProvider } from './trace/index';

// ── Domain types (same shapes the frontend already uses) ─────────────────────

export interface User {
  id: string;
  name: string;
  email: string;
  age: number;
  status: 'active' | 'inactive';
  loginCount: number;
}

export interface AnalyticsEvent {
  eventId: string;
  eventType: string;
  userId: string;
  metadata: Record<string, unknown>;
  timestamp: number;
}

export interface EventTypeStat {
  eventType: string;
  count: number;
  lastSeen: number;
}

export interface AnalyticsStats {
  totalEvents: number;
  byType: EventTypeStat[];
  cachedAt: number;
  fromCache: boolean;
}

export interface MinutelyStat {
  windowMs: number;
  eventType: string;
  count: number;
}

export interface CreateUserPayload {
  name: string;
  email: string;
  password: string;
  age?: number;
}
export interface ReplaceUserPayload {
  name: string;
  email: string;
  password?: string;
  age?: number;
  status: 'active' | 'inactive';
  /** The caller's current password; required to change their own password or email. */
  currentPassword?: string;
}
export interface PatchUserPayload {
  name?: string;
  email?: string;
  password?: string;
  age?: number;
  status?: 'active' | 'inactive';
  /** The caller's current password; required to change their own password or email. */
  currentPassword?: string;
}

/** One page of users (AIP-158). */
export interface UserPage {
  users: User[];
  /** Pass as `pageToken` to read the next page; empty on the last page. */
  nextPageToken: string;
  /** Users across all pages. */
  totalSize: number;
}

export interface ListUsersOptions {
  /** Maximum users per page; the server default when omitted. */
  pageSize?: number;
  /** `nextPageToken` of the previous page; omit for the first page. */
  pageToken?: string;
}

export type EventType =
  | 'page_view'
  | 'button_click'
  | 'api_call'
  | 'error'
  | 'purchase';

// ── Tracking (user-behavior) insights ────────────────────────────────────────

export interface TrackingPageCount {
  page: string;
  count: number;
}

export interface TrackingEventCount {
  eventName: string;
  count: number;
}

export interface TrackingDailyUnique {
  day: string; // YYYY-MM-DD
  uniques: number;
}

export interface TrackingRecentEvent {
  eventId: string;
  eventName: string;
  anonymousId: string;
  userId: string;
  sessionId: string;
  page: string;
  props: Record<string, unknown>;
  timestamp: number;
}

export interface TrackingFunnelStep {
  step: string;
  users: number;
}

export interface TrackingInsights {
  topPages: TrackingPageCount[];
  eventsByName: TrackingEventCount[];
  dailyUniques: TrackingDailyUnique[];
  recent: TrackingRecentEvent[];
  funnel: TrackingFunnelStep[];
}

// ── Mappers (proto messages → domain types; int64 comes back as bigint) ──────

/** Epoch ms from the Timestamp field, falling back to the deprecated int64 one. */
function epochMs(time: Timestamp | undefined, legacy: bigint): number {
  return time ? timestampMs(time) : Number(legacy);
}

function toUser(u: UserResponse): User {
  return {
    id: u.id,
    name: u.name,
    email: u.email,
    age: u.age,
    status: (u.status || 'active') as User['status'],
    loginCount: u.loginCount,
  };
}

function toEvent(e: EventResponse): AnalyticsEvent {
  let metadata: Record<string, unknown> = {};
  try {
    if (e.metadata)
      metadata = JSON.parse(e.metadata) as Record<string, unknown>;
  } catch {
    metadata = {};
  }
  return {
    eventId: e.eventId,
    eventType: e.eventType,
    userId: e.userId,
    metadata,
    timestamp: epochMs(e.eventTime, e.timestamp),
  };
}

// ── Api ───────────────────────────────────────────────────────────────────────

export interface ApiOptions {
  /** Backend RPC endpoint (Connect protocol), e.g. http://localhost:50051. */
  rpcBaseUrl: string;
  /** REST API origin (avatar upload etc.). */
  restBaseUrl: string;
  /**
   * Returns the current bearer token, or null. Defaults to the SDK's
   * in-memory store, which login, refresh and logout write.
   */
  getToken?: () => string | null;
  /** Per-RPC deadline in milliseconds. */
  timeoutMs?: number;
  /**
   * Tenant sent as X-Tenant-ID. Required for calls made without a token
   * (login, sign-up); with a token the backend takes the token's tenant and
   * rejects a different one (TENANT_MISMATCH).
   */
  tenantId?: string;
  /** Active W3C traceparent per call; a fresh trace when it returns none. */
  traceparent?: TraceparentProvider;
}

export interface Api {
  /** Raw typed connect clients, for callers needing the full proto surface. */
  clients: Sdk;
  rest: RestClient;

  // Auth
  /** Current access token (memory only), or null. */
  getToken: () => string | null;
  login: (email: string, password: string) => Promise<void>;
  /**
   * Restores the session on app start from the refresh cookie; resolves to
   * whether a session exists. Also removes tokens older SDK versions left in
   * localStorage.
   */
  restoreSession: () => Promise<boolean>;
  /**
   * Starts an OAuth sign-in: keeps a PKCE verifier in sessionStorage and
   * resolves to the URL to navigate the browser to.
   */
  startOAuthSignIn: (provider: OAuthProvider) => Promise<string>;
  /**
   * Finishes an OAuth sign-in: trades the one-time code from the callback
   * URL fragment (`/auth/callback#code=...`), with the verifier the start
   * stored, for an access token.
   */
  completeOAuthSignIn: (code: string) => Promise<void>;
  /** Revokes the session server-side, then clears it locally and in other tabs. */
  logout: () => Promise<void>;

  // Users
  /** First page of users. */
  fetchUsers: (pageSize?: number) => Promise<User[]>;
  listUsers: (options?: ListUsersOptions) => Promise<UserPage>;
  fetchUser: (id: string) => Promise<User>;
  fetchMe: () => Promise<User>;
  createUser: (body: CreateUserPayload) => Promise<User>;
  replaceUser: (id: string, body: ReplaceUserPayload) => Promise<User>;
  patchUser: (id: string, body: PatchUserPayload) => Promise<User>;
  deleteUser: (id: string) => Promise<void>;
  searchUsers: (query: string, size?: number) => Promise<User[]>;
  findSimilarUsers: (userId: string, limit?: number) => Promise<User[]>;
  uploadAvatar: (userId: string, file: File) => Promise<string>;
  /** Roles of every user in the tenant, keyed by user id (admin only). */
  getUserRoles: () => Promise<Record<string, string[]>>;
  /** Replaces a user's roles (admin only). */
  setUserRoles: (
    id: string,
    roles: string[],
  ) => Promise<{ id: string; roles: string[] }>;

  // Workflows
  listOnboardingWorkflows: () => Promise<OnboardingWorkflows>;

  // Health
  getHealth: () => Promise<HealthStatus>;

  // Analytics
  fireEvent: (
    eventType: EventType,
    userId: string,
    metadata?: Record<string, unknown>,
  ) => Promise<AnalyticsEvent>;
  fetchStats: () => Promise<AnalyticsStats>;
  fetchRecent: () => Promise<AnalyticsEvent[]>;
  fetchMinutelyStats: (minutes?: number) => Promise<MinutelyStat[]>;

  // Tracking (user behavior) — read side; ingest goes through createTracker()
  fetchTrackingInsights: (days?: number) => Promise<TrackingInsights>;
}

/** Tabs of one app tell each other about a logout. */
const AUTH_CHANNEL = 'tropis-auth';

function authChannel(): BroadcastChannel | undefined {
  try {
    return typeof BroadcastChannel === 'undefined'
      ? undefined
      : new BroadcastChannel(AUTH_CHANNEL);
  } catch {
    return undefined;
  }
}

export function createApi(options: ApiOptions): Api {
  const getToken = options.getToken ?? getStoredToken;
  // Shared single-flight refresher — both transports refresh-on-401 through it.
  const refresh = createRefresher(options.restBaseUrl, {
    traceparent: options.traceparent,
  });
  const channel = authChannel();
  channel?.addEventListener('message', (e: MessageEvent) => {
    if (e.data === 'logout') clearToken();
  });
  const clients = createSdk({
    baseUrl: options.rpcBaseUrl,
    getToken,
    timeoutMs: options.timeoutMs,
    tenantId: options.tenantId,
    traceparent: options.traceparent,
    refresh,
  });
  const rest = createRestClient({
    baseUrl: options.restBaseUrl,
    getToken,
    tenantId: options.tenantId,
    traceparent: options.traceparent,
    refresh,
  });

  const listUsers = async ({
    pageSize = 0,
    pageToken = '',
  }: ListUsersOptions = {}): Promise<UserPage> => {
    const res = await clients.users.findAll({ pageSize, pageToken });
    return {
      users: res.users.map(toUser),
      nextPageToken: res.nextPageToken,
      totalSize: res.totalSize,
    };
  };

  const fetchRecent = async (): Promise<AnalyticsEvent[]> => {
    const res = await clients.analytics.getRecent({});
    return res.events.map(toEvent);
  };

  return {
    clients,
    rest,

    getToken,

    async login(email, password) {
      // Login over REST (not RPC): the REST endpoint runs the full
      // AuthService (lockout) and sets the refresh cookie that keeps the
      // session alive; RPC Login only returns an access token.
      const { accessToken } = await rest.login(email, password);
      if (!accessToken) throw new Error('Login failed: no token in response');
      setToken(accessToken);
    },

    async restoreSession() {
      clearLegacyTokens();
      if (getToken()) return true;
      return (await refresh()) !== null;
    },

    async startOAuthSignIn(provider) {
      return rest.oauthStartUrl(provider, await beginPkce());
    },

    async completeOAuthSignIn(code) {
      const verifier = takePkceVerifier();
      if (!verifier) {
        throw new Error(
          'This sign-in was not started in this browser tab; start it again',
        );
      }
      const { accessToken } = await rest.exchangeOAuthCode(code, verifier);
      if (!accessToken) throw new Error('Sign-in failed: no token in response');
      setToken(accessToken);
    },

    async logout() {
      // Server first, while the access token is still at hand: the server
      // revokes it and the refresh cookie. rest.logout swallows its own
      // errors, so a network failure still clears the local session.
      await rest.logout();
      clearToken();
      channel?.postMessage('logout');
    },

    async fetchUsers(pageSize = 20) {
      return (await listUsers({ pageSize })).users;
    },

    listUsers,

    async fetchUser(id) {
      return toUser(await clients.users.findById({ id }));
    },

    async fetchMe() {
      return toUser(await clients.users.getMe({}));
    },

    async createUser(body) {
      return toUser(
        await clients.users.create({
          name: body.name,
          email: body.email,
          password: body.password,
          age: body.age ?? 0,
        }),
      );
    },

    async replaceUser(id, body) {
      return toUser(
        await clients.users.replace({
          id,
          name: body.name,
          email: body.email,
          status: body.status,
          password: body.password ?? '',
          age: body.age ?? 0,
          currentPassword: body.currentPassword ?? '',
        }),
      );
    },

    async patchUser(id, body) {
      return toUser(
        await clients.users.update({
          id,
          name: body.name ?? '',
          email: body.email ?? '',
          password: body.password ?? '',
          age: body.age ?? 0,
          status: body.status ?? '',
          currentPassword: body.currentPassword ?? '',
        }),
      );
    },

    async deleteUser(id) {
      await clients.users.delete({ id });
    },

    async searchUsers(query, size = 10) {
      const res = await clients.users.search({ query, pageSize: size });
      return res.users.map(toUser);
    },

    async findSimilarUsers(userId, limit = 5) {
      const res = await clients.users.findSimilar({ userId, pageSize: limit });
      return res.users.map(toUser);
    },

    uploadAvatar: (userId, file) => rest.uploadAvatar(userId, file),
    getUserRoles: () => rest.getUserRoles(),
    setUserRoles: (id, roles) => rest.setUserRoles(id, roles),
    listOnboardingWorkflows: () => rest.listOnboardingWorkflows(),
    getHealth: () => rest.getHealth(),

    async fireEvent(eventType, userId, metadata) {
      const res = await clients.analytics.createEvent({
        eventType,
        userId,
        metadata: metadata ? JSON.stringify(metadata) : '',
      });
      return toEvent(res);
    },

    async fetchStats() {
      const res = await clients.analytics.getStats({});
      return {
        totalEvents: res.totalEvents,
        byType: res.byType.map((s) => ({
          eventType: s.eventType,
          count: s.count,
          lastSeen: epochMs(s.lastSeenTime, s.lastSeen),
        })),
        cachedAt: epochMs(res.cacheTime, res.cachedAt),
        fromCache: res.fromCache,
      };
    },

    fetchRecent,

    async fetchMinutelyStats(minutes = 60) {
      const res = await clients.analytics.getMinutelyStats({ minutes });
      return res.stats.map((s) => ({
        windowMs: epochMs(s.windowStartTime, s.windowMs),
        eventType: s.eventType,
        count: s.count,
      }));
    },

    async fetchTrackingInsights(days = 7) {
      const res = await clients.tracking.getInsights({ days });
      return {
        topPages: res.topPages.map((p) => ({ page: p.page, count: p.count })),
        eventsByName: res.eventsByName.map((e) => ({
          eventName: e.eventName,
          count: e.count,
        })),
        dailyUniques: res.dailyUniques.map((d) => ({
          day: d.day,
          uniques: d.uniques,
        })),
        recent: res.recent.map((r) => {
          let props: Record<string, unknown> = {};
          try {
            if (r.props) props = JSON.parse(r.props) as Record<string, unknown>;
          } catch {
            props = {};
          }
          return {
            eventId: r.eventId,
            eventName: r.eventName,
            anonymousId: r.anonymousId,
            userId: r.userId,
            sessionId: r.sessionId,
            page: r.page,
            props,
            timestamp: epochMs(r.eventTime, r.timestamp),
          };
        }),
        funnel: res.funnel.map((s) => ({ step: s.step, users: s.users })),
      };
    },
  };
}
