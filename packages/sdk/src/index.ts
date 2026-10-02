// @tropis/sdk — typed client SDK generated from the v1 protos.

// Typed RPC clients (Connect protocol)
export {
  createSdk,
  TENANT_HEADER,
  type Sdk,
  type SdkOptions,
} from './client/index';

// High-level API facade
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
  type TrackingFunnelStep,
  type UserPage,
  type ListUsersOptions,
} from './api';

// REST helpers
export {
  createRestClient,
  type RestClient,
  type RestOptions,
  type AccessTokenResponse,
  type OAuthProvider,
  type OnboardingWorkflow,
  type OnboardingWorkflows,
  type UserRoles,
  type UserRolesPage,
  type UserRolesOptions,
  type HealthCheck,
  type HealthStatus,
} from './rest/index';

// Realtime (Socket.io)
export {
  connectRealtime,
  isRealtimeConnected,
  type RealtimeOptions,
  type WsEvent,
  type WsEventName,
} from './realtime/index';

// Errors
export {
  parseApiError,
  readApiError,
  isProblemBody,
  ApiRequestError,
  ERROR_DOMAIN,
  type ApiError,
  type FieldError,
  type ProblemDetails,
} from './errors/index';
export { Code, ConnectError } from '@connectrpc/connect';

// Access-token store (memory only; the refresh token is an httpOnly cookie,
// or a SecureTokenStore in a native shell)
export {
  getToken,
  setToken,
  clearToken,
  onTokenChange,
  clearLegacyTokens,
  type TokenListener,
} from './auth/token';
export {
  createRefresher,
  type Refresher,
  type RefresherOptions,
} from './auth/refresh';
export type { SecureTokenStore } from './auth/session-store';
export {
  OAUTH_VERIFIER_KEY,
  createCodeVerifier,
  codeChallenge,
} from './auth/pkce';

// Tracking (user-behavior tracker)
export {
  createTracker,
  type Tracker,
  type TrackerOptions,
  type TrackedEvent,
} from './tracking/index';

// W3C Trace Context
export {
  TRACEPARENT_HEADER,
  generateTraceparent,
  isValidTraceparent,
  type TraceparentProvider,
} from './trace/index';

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
export * as signingv1 from './gen/signing/v1/signing_pb';
export * as healthv1 from './gen/health/v1/health_pb';
