/**
 * Typed gRPC-Web clients generated from the v1 protos.
 *
 * Architecture:
 *   Browser  →  connect-web gRPC-Web transport (HTTP/1.1)
 *           →  Envoy (gRPC-Web filter, transcodes to HTTP/2 gRPC)
 *           →  NestJS gRPC server
 */

import {
  createClient,
  Code,
  ConnectError,
  type Client,
  type Interceptor,
} from '@connectrpc/connect';
import { createGrpcWebTransport } from '@connectrpc/connect-web';
import { AuthService } from '../gen/auth/v1/auth_pb';
import { UserService } from '../gen/user/v1/user_pb';
import { AnalyticsService } from '../gen/analytics/v1/analytics_pb';
import { TrackingService } from '../gen/tracking/v1/tracking_pb';
import type { Refresher } from '../auth/refresh';

export interface SdkOptions {
  /** Base URL of the Envoy gRPC-Web endpoint, e.g. http://localhost:8080 */
  baseUrl: string;
  /** Returns the current bearer token, or null when unauthenticated. */
  getToken?: () => string | null;
  /** Per-RPC deadline in milliseconds (default 10 s). */
  timeoutMs?: number;
  /** Called on an Unauthenticated response to mint a new access token; the
   *  call is retried once when it returns a token (refresh-on-401). */
  refresh?: Refresher;
}

export interface Sdk {
  auth: Client<typeof AuthService>;
  users: Client<typeof UserService>;
  analytics: Client<typeof AnalyticsService>;
  tracking: Client<typeof TrackingService>;
}

const DEFAULT_TIMEOUT_MS = 10_000;

export function createSdk(options: SdkOptions): Sdk {
  const {
    baseUrl,
    getToken,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    refresh,
  } = options;

  const authInterceptor: Interceptor = (next) => (req) => {
    const token = getToken?.();
    if (token) req.header.set('Authorization', `Bearer ${token}`);
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

  const transport = createGrpcWebTransport({
    baseUrl,
    interceptors: refresh
      ? [refreshInterceptor, authInterceptor]
      : [authInterceptor],
    defaultTimeoutMs: timeoutMs,
  });

  return {
    auth: createClient(AuthService, transport),
    users: createClient(UserService, transport),
    analytics: createClient(AnalyticsService, transport),
    tracking: createClient(TrackingService, transport),
  };
}
