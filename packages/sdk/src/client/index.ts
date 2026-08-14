/**
 * Typed gRPC-Web clients generated from the v1 protos.
 *
 * Architecture:
 *   Browser  →  connect-web gRPC-Web transport (HTTP/1.1)
 *           →  Envoy (gRPC-Web filter, transcodes to HTTP/2 gRPC)
 *           →  NestJS gRPC server
 */

import { createClient, type Client, type Interceptor } from '@connectrpc/connect';
import { createGrpcWebTransport } from '@connectrpc/connect-web';
import { AuthService } from '../gen/auth/v1/auth_pb';
import { UserService } from '../gen/user/v1/user_pb';
import { AnalyticsService } from '../gen/analytics/v1/analytics_pb';
import { TrackingService } from '../gen/tracking/v1/tracking_pb';

export interface SdkOptions {
  /** Base URL of the Envoy gRPC-Web endpoint, e.g. http://localhost:8080 */
  baseUrl: string;
  /** Returns the current bearer token, or null when unauthenticated. */
  getToken?: () => string | null;
  /** Per-RPC deadline in milliseconds (default 10 s). */
  timeoutMs?: number;
}

export interface Sdk {
  auth: Client<typeof AuthService>;
  users: Client<typeof UserService>;
  analytics: Client<typeof AnalyticsService>;
  tracking: Client<typeof TrackingService>;
}

const DEFAULT_TIMEOUT_MS = 10_000;

export function createSdk(options: SdkOptions): Sdk {
  const { baseUrl, getToken, timeoutMs = DEFAULT_TIMEOUT_MS } = options;

  const authInterceptor: Interceptor = (next) => (req) => {
    const token = getToken?.();
    if (token) req.header.set('Authorization', `Bearer ${token}`);
    return next(req);
  };

  const transport = createGrpcWebTransport({
    baseUrl,
    interceptors: [authInterceptor],
    defaultTimeoutMs: timeoutMs,
  });

  return {
    auth: createClient(AuthService, transport),
    users: createClient(UserService, transport),
    analytics: createClient(AnalyticsService, transport),
    tracking: createClient(TrackingService, transport),
  };
}
