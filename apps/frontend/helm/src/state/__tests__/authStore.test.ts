import { describe, expect, it, vi, type Mock } from 'vitest';

const state = vi.hoisted(() => ({
  token: null as string | null,
  listeners: [] as Array<(t: string | null) => void>,
}));

vi.mock('../../lib/api', () => ({
  getToken: vi.fn(() => state.token),
  setToken: vi.fn((t: string) => {
    state.token = t;
  }),
  onTokenChange: vi.fn((l: (t: string | null) => void) => {
    state.listeners.push(l);
    return () => undefined;
  }),
  restoreSession: vi.fn(),
  logout: vi.fn(() => {
    state.token = null;
    return Promise.resolve();
  }),
}));
vi.mock('../../lib/caches', () => ({ clearRuntimeCaches: vi.fn() }));

import * as api from '../../lib/api';
import * as caches from '../../lib/caches';
import { useAuthStore } from '../zustand/authStore';

describe('authStore', () => {
  it('starts restoring, then signs in from the refresh cookie', async () => {
    expect(useAuthStore.getState()).toMatchObject({
      restoring: true,
      authed: false,
    });
    (api.restoreSession as Mock).mockImplementation(() => {
      state.token = 'restored';
      return Promise.resolve(true);
    });

    await useAuthStore.getState().restore();

    expect(useAuthStore.getState()).toMatchObject({
      restoring: false,
      authed: true,
      token: 'restored',
    });
  });

  it('signs out when the SDK drops the token (a failed refresh)', () => {
    for (const l of state.listeners) l(null);
    expect(useAuthStore.getState().authed).toBe(false);
  });

  it('clears the runtime caches on logout', async () => {
    useAuthStore.getState().login('t');
    await useAuthStore.getState().logout();
    expect(api.logout).toHaveBeenCalled();
    expect(caches.clearRuntimeCaches).toHaveBeenCalled();
    expect(useAuthStore.getState().authed).toBe(false);
  });
});
