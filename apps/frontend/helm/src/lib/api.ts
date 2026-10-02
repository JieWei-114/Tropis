/**
 * App-wide @tropis/sdk singleton.
 *
 * Constructs the typed SDK once with the validated env config and re-exports
 * its function surface so no caller has to build a client or pass a token.
 * The SDK keeps the access token in memory. In a browser the refresh token
 * is an httpOnly cookie and helm stores nothing auth-related; in a native
 * shell it lives in OS secure storage (lib/native.ts).
 */

import { createApi } from '@tropis/sdk';
import { env } from './env';
import {
  nativeShell,
  onOAuthCallback,
  openInSystemBrowser,
  secureTokenStore,
} from './native';

const shell = nativeShell();

export const api = createApi({
  rpcBaseUrl: env.VITE_RPC_URL,
  restBaseUrl: env.VITE_API_BASE_URL,
  tenantId: env.VITE_TENANT_ID,
  secureTokenStore: shell ? secureTokenStore(shell) : undefined,
});

/**
 * Goes to an OAuth start URL: the page navigates there in a browser (resolves
 * true), the system browser opens it in a native shell (resolves false).
 */
export async function openOAuthStart(url: string): Promise<boolean> {
  if (!shell) {
    window.location.assign(url);
    return true;
  }
  await openInSystemBrowser(shell, url);
  return false;
}

/**
 * Native shells: calls `onCode` for every OAuth callback deep link; a no-op
 * in a browser, where the provider redirects to /auth/callback itself.
 */
export function onNativeOAuthCallback(
  onCode: (code: string) => void,
): () => void {
  return shell ? onOAuthCallback(shell, onCode) : () => undefined;
}

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
