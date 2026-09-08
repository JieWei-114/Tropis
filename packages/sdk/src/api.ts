/**
 * High-level API facade — wraps the generated connect-es clients in a flat,
 * domain-typed function surface so callers never touch proto messages or
 * transport details.
 */

import { createSdk, type Sdk } from './client/index';
import { createRestClient, type RestClient } from './rest/index';
import {
  setToken,
  setRefreshToken,
  getRefreshToken,
  clearTokens,
} from './auth/token';
import { createRefresher } from './auth/refresh';
import type { UserResponse } from './gen/user/v1/user_pb';
import type { EventResponse } from './gen/analytics/v1/analytics_pb';

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
}
export interface PatchUserPayload {
  name?: string;
  email?: string;
  password?: string;
  age?: number;
  status?: 'active' | 'inactive';
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
    timestamp: Number(e.timestamp),
  };
}

// ── Api ───────────────────────────────────────────────────────────────────────

export interface ApiOptions {
  /** gRPC-Web (Envoy) endpoint. */
  grpcBaseUrl: string;
  /** REST API origin (avatar upload etc.). */
  restBaseUrl: string;
  /** Returns the current bearer token, or null. */
  getToken?: () => string | null;
  /** Per-RPC deadline in milliseconds. */
  timeoutMs?: number;
}

export interface Api {
  /** Raw typed connect clients, for callers needing the full proto surface. */
  clients: Sdk;
  rest: RestClient;

  // Auth
  login: (email: string, password: string) => Promise<void>;
  /** Revokes the tokens server-side, then clears them locally. */
  logout: () => Promise<void>;

  // Users
  fetchUsers: (page?: number, limit?: number) => Promise<User[]>;
  fetchUser: (id: string) => Promise<User>;
  fetchMe: () => Promise<User>;
  createUser: (body: CreateUserPayload) => Promise<User>;
  replaceUser: (id: string, body: ReplaceUserPayload) => Promise<User>;
  patchUser: (id: string, body: PatchUserPayload) => Promise<User>;
  deleteUser: (id: string) => Promise<void>;
  searchUsers: (query: string, size?: number) => Promise<User[]>;
  findSimilarUsers: (userId: string, limit?: number) => Promise<User[]>;
  uploadAvatar: (userId: string, file: File) => Promise<string>;

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

export function createApi(options: ApiOptions): Api {
  // Shared single-flight refresher — both transports refresh-on-401 through it.
  const refresh = createRefresher(options.restBaseUrl);
  const clients = createSdk({
    baseUrl: options.grpcBaseUrl,
    getToken: options.getToken,
    timeoutMs: options.timeoutMs,
    refresh,
  });
  const rest = createRestClient({
    baseUrl: options.restBaseUrl,
    getToken: options.getToken,
    refresh,
  });

  const fetchRecent = async (): Promise<AnalyticsEvent[]> => {
    const res = await clients.analytics.getRecent({});
    return res.events.map(toEvent);
  };

  return {
    clients,
    rest,

    async login(email, password) {
      // Login over REST (not gRPC): the REST endpoint runs the full AuthService
      // (lockout + a rotating REFRESH token), where gRPC Login only returns an
      // access token. Storing the refresh token is what enables refresh-on-401.
      const { accessToken, refreshToken } = await rest.login(email, password);
      if (!accessToken) throw new Error('Login failed: no token in response');
      setToken(accessToken);
      if (refreshToken) setRefreshToken(refreshToken);
    },

    async logout() {
      // Server first: the access token lives 7 days and the refresh token
      // longer, so dropping only the local copy leaves both valid server-side
      // and the session resumable from any copy of the token. rest.logout
      // swallows its own errors, so a network failure still clears local state
      // rather than trapping the user signed in.
      await rest.logout(getRefreshToken() ?? undefined);
      clearTokens();
    },

    async fetchUsers(page = 1, limit = 20) {
      const res = await clients.users.findAll({ page, limit });
      return res.users.map(toUser);
    },

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
        }),
      );
    },

    async deleteUser(id) {
      await clients.users.delete({ id });
    },

    async searchUsers(query, size = 10) {
      const res = await clients.users.search({ query, size });
      return res.users.map(toUser);
    },

    async findSimilarUsers(userId, limit = 5) {
      const res = await clients.users.findSimilar({ userId, limit });
      return res.users.map(toUser);
    },

    uploadAvatar: (userId, file) => rest.uploadAvatar(userId, file),

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
          lastSeen: Number(s.lastSeen),
        })),
        cachedAt: Number(res.cachedAt),
        fromCache: res.fromCache,
      };
    },

    fetchRecent,

    async fetchMinutelyStats(minutes = 60) {
      const res = await clients.analytics.getMinutelyStats({ minutes });
      return res.stats.map((s) => ({
        windowMs: Number(s.windowMs),
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
            timestamp: Number(r.timestamp),
          };
        }),
        funnel: res.funnel.map((s) => ({ step: s.step, users: s.users })),
      };
    },
  };
}
