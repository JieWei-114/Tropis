// @tropis/sdk — typed client SDK generated from the v1 protos.

// Typed gRPC-Web clients
export { createSdk, type Sdk, type SdkOptions } from './client/index';

// High-level API facade (same surface the frontend consumed from lib/grpc-web.ts)
export {
  createApi,
  type Api,
  type ApiOptions,
  type User,
  type AnalyticsEvent,
  type EventTypeStat,
  type AnalyticsStats,
  type MinutelyStat,
  type CreateUserPayload,
  type ReplaceUserPayload,
  type PatchUserPayload,
  type EventType,
  type TrackingInsights,
  type TrackingPageCount,
  type TrackingEventCount,
  type TrackingDailyUnique,
  type TrackingRecentEvent,
} from './api';

// REST helpers
export { createRestClient, type RestClient, type RestOptions } from './rest/index';

// Realtime (Socket.io)
export {
  connectRealtime,
  isRealtimeConnected,
  type RealtimeOptions,
  type WsEvent,
  type WsEventName,
} from './realtime/index';

// Errors
export { parseApiError, type ApiError } from './errors/index';
export { Code, ConnectError } from '@connectrpc/connect';

// Token store
export { getToken, setToken, clearToken } from './auth/token';

// Tracking (user-behavior 埋点 tracker)
export {
  createTracker,
  type Tracker,
  type TrackerOptions,
  type TrackedEvent,
} from './tracking/index';

// Request signing (server-to-server HMAC — docs/api-conventions.md;
// never use in browsers: secrets don't belong in client-side JS)
export {
  signRequest,
  createSignedFetch,
  type SignRequestInput,
  type SignedHeaders,
  type SignedFetchOptions,
} from './signing/index';

// Raw generated types (namespaced — EmptyRequest etc. exist in several packages)
export * as authv1 from './gen/auth/v1/auth_pb';
export * as userv1 from './gen/user/v1/user_pb';
export * as analyticsv1 from './gen/analytics/v1/analytics_pb';
export * as trackingv1 from './gen/tracking/v1/tracking_pb';
