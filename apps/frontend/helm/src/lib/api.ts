/**
 * App-wide @tropis/sdk singleton.
 *
 * Constructs the typed SDK once with the validated env config and re-exports
 * its function surface so no caller has to build a client or pass a token.
 * The SDK keeps the access token in memory and the refresh token in an
 * httpOnly cookie; nothing auth-related is stored by helm.
 */

import { createApi } from '@tropis/sdk';
import { env } from './env';

export const api = createApi({
  rpcBaseUrl: env.VITE_RPC_URL,
  restBaseUrl: env.VITE_API_BASE_URL,
  tenantId: env.VITE_TENANT_ID,
});

// Access-token store (memory only, lives in the SDK)
export { getToken, setToken, onTokenChange } from '@tropis/sdk';

// Domain types
export type {
  User,
  AnalyticsEvent,
  EventTypeStat,
  AnalyticsStats,
  MinutelyStat,
  CreateUserPayload,
  ReplaceUserPayload,
  EventType,
  HealthStatus,
  HealthCheck,
  OAuthProvider,
  OnboardingWorkflow,
  OnboardingWorkflows,
} from '@tropis/sdk';

// Auth
export const login = api.login;
export const restoreSession = api.restoreSession;
export const startOAuthSignIn = api.startOAuthSignIn;
export const completeOAuthSignIn = api.completeOAuthSignIn;
export const logout = api.logout;

// Users
export const fetchUsers = api.fetchUsers;
export const createUser = api.createUser;
export const replaceUser = api.replaceUser;
export const deleteUser = api.deleteUser;
export const searchUsers = api.searchUsers;
export const findSimilarUsers = api.findSimilarUsers;
export const uploadAvatar = api.uploadAvatar;
export const getUserRoles = api.getUserRoles;
export const setUserRoles = api.setUserRoles;

// Workflows
export const listOnboardingWorkflows = api.listOnboardingWorkflows;

// Health
export const getHealth = api.getHealth;

// Analytics
export const fireEvent = api.fireEvent;
export const fetchStats = api.fetchStats;
export const fetchRecent = api.fetchRecent;
export const fetchMinutelyStats = api.fetchMinutelyStats;
