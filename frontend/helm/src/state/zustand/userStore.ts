/**
 * ZUSTAND — User Store
 *
 * Global user list with async actions built into the store.
 * Notice how loading/error state lives alongside the data — no separate useState.
 *
 * Key difference from local state:
 *   - Navigate away and back → list is already loaded (no re-fetch)
 *   - Two components can read `users` without duplicating the fetch
 *   - Actions (create/update/delete) are defined once, used anywhere
 */

import { create } from 'zustand';
import { devtools } from 'zustand/middleware';
import {
  fetchUsers,
  createUser,
  replaceUser,
  deleteUser,
  searchUsers,
  findSimilarUsers,
  type User,
  type CreateUserPayload,
  type ReplaceUserPayload,
} from '../../lib/api';

interface UserState {
  // ── State ──────────────────────────────────────────
  users: User[];
  loading: boolean;
  error: string | null;
  lastFetchedAt: number | null;

  // ── Actions ────────────────────────────────────────
  fetchAll: () => Promise<void>;
  create: (data: CreateUserPayload) => Promise<User>;
  replace: (id: string, data: ReplaceUserPayload) => Promise<User>;
  remove: (id: string) => Promise<void>;
  search: (query: string) => Promise<void>;
  findSimilar: (userId: string) => Promise<void>;
  reset: () => void;
}

export const useUserStore = create<UserState>()(
  devtools(
    (set, get) => ({
      users: [],
      loading: false,
      error: null,
      lastFetchedAt: null,

      fetchAll: async () => {
        // Skip if fetched within last 30s (simple cache)
        const { lastFetchedAt } = get();
        if (lastFetchedAt && Date.now() - lastFetchedAt < 30_000) return;

        set({ loading: true, error: null }, false, 'users/fetchAll:start');
        try {
          const users = await fetchUsers();
          set(
            { users, loading: false, lastFetchedAt: Date.now() },
            false,
            'users/fetchAll:done',
          );
        } catch (e) {
          set(
            { error: (e as Error).message, loading: false },
            false,
            'users/fetchAll:error',
          );
        }
      },

      create: async (data) => {
        const user = await createUser(data);
        set(
          (state) => ({
            users: [user, ...state.users],
            lastFetchedAt: Date.now(),
          }),
          false,
          'users/create',
        );
        return user;
      },

      replace: async (id, data) => {
        const user = await replaceUser(id, data);
        set(
          (state) => ({
            users: state.users.map((u) => (u.id === id ? user : u)),
          }),
          false,
          'users/replace',
        );
        return user;
      },

      remove: async (id) => {
        await deleteUser(id);
        set(
          (state) => ({ users: state.users.filter((u) => u.id !== id) }),
          false,
          'users/remove',
        );
      },

      search: async (query) => {
        set({ loading: true }, false, 'users/search:start');
        try {
          const users = await searchUsers(query);
          set({ users, loading: false }, false, 'users/search:done');
        } catch {
          set({ loading: false }, false, 'users/search:error');
        }
      },

      findSimilar: async (userId) => {
        set({ loading: true }, false, 'users/findSimilar:start');
        try {
          const users = await findSimilarUsers(userId);
          set({ users, loading: false }, false, 'users/findSimilar:done');
        } catch {
          set({ loading: false }, false, 'users/findSimilar:error');
        }
      },

      reset: () =>
        set(
          { users: [], lastFetchedAt: null, error: null },
          false,
          'users/reset',
        ),
    }),
    { name: 'UserStore' },
  ),
);
