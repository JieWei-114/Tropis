/**
 * ZUSTAND — Auth Store
 *
 * Global auth state. Any component can read/write without prop-drilling.
 *
 * The access token lives in the SDK's in-memory store; this store mirrors
 * it. A reload restores the session through the httpOnly refresh cookie
 * (`restore`), a failed refresh anywhere clears the SDK token and so signs
 * the console out here, and a logout in another tab reaches this one over
 * the SDK's BroadcastChannel.
 */

import { create } from 'zustand';
import { devtools } from 'zustand/middleware';
import {
  getToken,
  setToken,
  onTokenChange,
  restoreSession,
  logout as apiLogout,
} from '../../lib/api';
import { clearRuntimeCaches } from '../../lib/caches';

interface AuthState {
  // ── State ──────────────────────────────────────────
  token: string | null;
  authed: boolean;
  /** True until the start-up session restore has answered. */
  restoring: boolean;

  // ── Actions ────────────────────────────────────────
  login: (token: string) => void;
  logout: () => Promise<void>;
  /** Restores the session from the refresh cookie; runs once on start. */
  restore: () => Promise<void>;
}

export const useAuthStore = create<AuthState>()(
  devtools(
    (set, get) => ({
      token: getToken(),
      authed: !!getToken(),
      restoring: true,

      login: (token) => {
        setToken(token);
        set({ token, authed: true, restoring: false }, false, 'auth/login');
      },

      logout: async () => {
        // Clear local state first so the UI never sits on a signed-in screen
        // waiting for the network, then revoke server-side. api.logout()
        // revokes the session and clears the token; it swallows its own
        // network errors, so this cannot leave the user stuck.
        set({ token: null, authed: false }, false, 'auth/logout');
        await apiLogout();
        await clearRuntimeCaches();
      },

      restore: async () => {
        if (!get().restoring) return;
        // Responses an older service worker cached must not survive.
        void clearRuntimeCaches();
        try {
          await restoreSession();
        } finally {
          const token = getToken();
          set(
            { token, authed: !!token, restoring: false },
            false,
            'auth/restore',
          );
        }
      },
    }),
    { name: 'AuthStore' },
  ),
);

// Mirror every change of the SDK token (refresh, failed refresh, logout in
// another tab) into the store.
onTokenChange((token) => {
  useAuthStore.setState({ token, authed: !!token }, false, 'auth/tokenChange');
});
