/**
 * App-wide @tropis/sdk singleton.
 *
 * Constructs the typed SDK once with the validated env config and the
 * localStorage-backed token store, and re-exports its function surface so no
 * caller has to build a client or pass a token.
 */

import { createApi, getToken } from '@tropis/sdk';
import { env } from './env';

export const api = createApi({
  grpcBaseUrl: env.VITE_GRPC_WEB_URL,
  restBaseUrl: env.VITE_API_BASE_URL,
  getToken,
});

// Token store (localStorage + JWT exp validation, lives in the SDK)
export { getToken, setToken } from '@tropis/sdk';

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
} from '@tropis/sdk';

// Auth
export const login = api.login;
export const logout = api.logout;

// Users
export const fetchUsers = api.fetchUsers;
export const createUser = api.createUser;
export const replaceUser = api.replaceUser;
export const deleteUser = api.deleteUser;
export const searchUsers = api.searchUsers;
export const findSimilarUsers = api.findSimilarUsers;
export const uploadAvatar = api.uploadAvatar;

// Analytics
export const fireEvent = api.fireEvent;
export const fetchStats = api.fetchStats;
export const fetchRecent = api.fetchRecent;
export const fetchMinutelyStats = api.fetchMinutelyStats;
