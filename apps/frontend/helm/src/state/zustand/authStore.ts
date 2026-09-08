/**
 * ZUSTAND — Auth Store
 *
 * Global auth state. Any component can read/write without prop-drilling.
 * Equivalent to Pinia's defineStore().
 *
 * ✅ Shared across all components — no prop-drilling
 * ✅ State persists while app is mounted (survives tab switches)
 * ✅ DevTools support (install Redux DevTools extension)
 * ✅ No Provider needed (unlike Context)
 */

import { create } from 'zustand';
import { devtools } from 'zustand/middleware';
import { getToken, setToken, logout as apiLogout } from '../../lib/api';

interface AuthState {
  // ── State ──────────────────────────────────────────
  token: string | null;
  authed: boolean;

  // ── Actions ────────────────────────────────────────
  login: (token: string) => void;
  logout: () => Promise<void>;
}

export const useAuthStore = create<AuthState>()(
  devtools(
    (set) => ({
      token: getToken(), // hydrate from localStorage on first load
      authed: !!getToken(),

      login: (token) => {
        setToken(token);
        set({ token, authed: true }, false, 'auth/login');
      },

      logout: async () => {
        // Clear local state first so the UI never sits on a signed-in screen
        // waiting for the network, then revoke server-side. api.logout()
        // revokes the access + refresh tokens and clears the token store; it
        // swallows its own network errors, so this cannot leave the user stuck.
        set({ token: null, authed: false }, false, 'auth/logout');
        await apiLogout();
      },
    }),
    { name: 'AuthStore' },
  ),
);

// ── Cross-tab sync ─────────────────────────────────────
// The 'storage' event fires in *other* tabs when localStorage changes.
// Logging out (or in) in one tab refreshes the in-memory auth state here,
// so a stale token is never kept alive in a background tab.
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e: StorageEvent) => {
    if (e.key !== 'token' && e.key !== null) return; // null = storage.clear()
    const token = getToken(); // re-read (also validates expiry)
    useAuthStore.setState(
      { token, authed: !!token },
      false,
      'auth/storageSync',
    );
  });
}
