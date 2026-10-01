/**
 * Typed RPC clients generated from the v1 protos.
 *
 * Architecture:
 *   Browser  →  connect-web Connect transport (binary protobuf over HTTP/1.1
 *               or HTTP/2, plain fetch)
 *           →  backend public RPC listener (RPC_PUBLIC_PORT), which answers
 *               Connect, gRPC-Web and gRPC on the same port
 *
 * The Connect protocol is used because it needs no proxy and no trailers, so
 * errors and unary calls behave like ordinary HTTP in the browser. Binary
 * rather than JSON keeps payloads small and int64 fields exact.
 */

import {
  createClient,
  Code,
  ConnectError,
  type Client,
  type Interceptor,
} from '@connectrpc/connect';
import { createConnectTransport } from '@connectrpc/connect-web';
import { AuthService } from '../gen/auth/v1/auth_pb';
import { UserService } from '../gen/user/v1/user_pb';
import { AnalyticsService } from '../gen/analytics/v1/analytics_pb';
import { TrackingService } from '../gen/tracking/v1/tracking_pb';
import { HEADERS } from '@tropis/shared';
import type { Refresher } from '../auth/refresh';
import {
  TRACEPARENT_HEADER,
  resolveTraceparent,
  type TraceparentProvider,
} from '../trace/index';

export interface SdkOptions {
  /** Base URL of the backend RPC endpoint, e.g. http://localhost:50051 */
  baseUrl: string;
  /** Returns the current bearer token, or null when unauthenticated. */
  getToken?: () => string | null;
  /** Per-RPC deadline in milliseconds (default 10 s). */
  timeoutMs?: number;
  /** Called on an Unauthenticated response to mint a new access token; the
   *  call is retried once when it returns a token (refresh-on-401). */
  refresh?: Refresher;
  /**
   * Tenant sent as X-Tenant-ID. Required for calls made without a token
   * (login, sign-up); with a token the backend takes the token's tenant and
   * rejects a different one (TENANT_MISMATCH).
   */
  tenantId?: string;
  /** Active W3C traceparent per call; a fresh trace when it returns none. */
  traceparent?: TraceparentProvider;
}

export interface Sdk {
  auth: Client<typeof AuthService>;
  users: Client<typeof UserService>;
  analytics: Client<typeof AnalyticsService>;
  tracking: Client<typeof TrackingService>;
}

const DEFAULT_TIMEOUT_MS = 10_000;

/** Header naming the caller's tenant (docs/api-conventions.md). */
export const TENANT_HEADER = HEADERS.TENANT;

export function createSdk(options: SdkOptions): Sdk {
  const {
    baseUrl,
    getToken,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    refresh,
    tenantId,
    traceparent,
  } = options;

  // Outermost, so a refresh-on-401 retry stays in the same trace.
  const traceInterceptor: Interceptor = (next) => (req) => {
    if (!req.header.has(TRACEPARENT_HEADER)) {
      req.header.set(TRACEPARENT_HEADER, resolveTraceparent(traceparent));
    }
    return next(req);
  };

  const authInterceptor: Interceptor = (next) => (req) => {
    const token = getToken?.();
    if (token) req.header.set('Authorization', `Bearer ${token}`);
    if (tenantId) req.header.set(TENANT_HEADER, tenantId);
    return next(req);
  };

  // Refresh-on-401: on an Unauthenticated unary call, mint a new access token
  // and retry ONCE. Retrying re-enters authInterceptor, which re-reads the
  // (now refreshed) token — no manual header juggling needed. Outermost so it
  // wraps the auth interceptor.
  const refreshInterceptor: Interceptor = (next) => async (req) => {
    try {
      return await next(req);
    } catch (err) {
      const unauth =
        err instanceof ConnectError && err.code === Code.Unauthenticated;
      if (!unauth || req.stream || !refresh) throw err;
      const token = await refresh();
      if (!token) throw err;
      return await next(req); // retry once with the refreshed token
    }
  };

  const transport = createConnectTransport({
    baseUrl,
    useBinaryFormat: true,
    interceptors: refresh
      ? [traceInterceptor, refreshInterceptor, authInterceptor]
      : [traceInterceptor, authInterceptor],
    defaultTimeoutMs: timeoutMs,
  });

  return {
    auth: createClient(AuthService, transport),
    users: createClient(UserService, transport),
    analytics: createClient(AnalyticsService, transport),
    tracking: createClient(TrackingService, transport),
  };
}
