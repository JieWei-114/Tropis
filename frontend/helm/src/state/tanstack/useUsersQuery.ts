/**
 * TANSTACK QUERY — User Queries & Mutations
 *
 * useQuery  = read data (fetch + cache + background refetch)
 * useMutation = write data (create/update/delete + cache invalidation)
 *
 * Key differences from local state + Zustand:
 *   ✅ Automatic background refetch when window is focused
 *   ✅ Deduplication — two components using the same query share one request
 *   ✅ onSuccess invalidation — create user → list auto-refetches
 *   ✅ Optimistic updates possible (show result before server confirms)
 *   ✅ Loading/error/stale states built-in
 *   ✅ Parallel queries with useQueries
 */

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  fetchUsers,
  createUser,
  replaceUser,
  deleteUser,
  searchUsers,
  findSimilarUsers,
  uploadAvatar,
  type User,
  type ReplaceUserPayload,
} from '../../lib/api';
import { queryKeys } from './queryClient';
import { useToastStore } from '../zustand/toastStore';

// ── Read ──────────────────────────────────────────────────────────────────────

export function useUsers() {
  return useQuery({
    queryKey: queryKeys.users.list(),
    queryFn: () => fetchUsers(),
    // staleTime from queryClient default (30s) — won't refetch if data is fresh
  });
}

export function useUserSearch(query: string) {
  return useQuery({
    queryKey: queryKeys.users.search(query),
    queryFn: () => searchUsers(query),
    enabled: query.trim().length > 0, // only runs when query is non-empty
    staleTime: 10_000,
  });
}

export function useSimilarUsers(userId: string | null) {
  return useQuery({
    queryKey: queryKeys.users.similar(userId ?? ''),
    queryFn: () => findSimilarUsers(userId!),
    enabled: !!userId,
    staleTime: 60_000, // vectors change rarely
  });
}

// ── Write ─────────────────────────────────────────────────────────────────────

export function useCreateUser() {
  const qc = useQueryClient();
  const push = useToastStore((s) => s.push);

  return useMutation({
    mutationFn: createUser,

    // Optimistic update — show new user immediately before server responds
    onMutate: async (newUser) => {
      await qc.cancelQueries({ queryKey: queryKeys.users.list() });
      const prev = qc.getQueryData(queryKeys.users.list());
      qc.setQueryData(queryKeys.users.list(), (old: User[] = []) => [
        { ...newUser, id: 'optimistic', status: 'active', loginCount: 0 },
        ...old,
      ]);
      return { prev }; // rollback context
    },

    onError: (_err, _vars, context) => {
      // Roll back optimistic update on error
      qc.setQueryData(queryKeys.users.list(), context?.prev);
      push({
        type: 'error',
        title: 'Create failed',
        message: 'Could not create user',
      });
    },

    onSuccess: (user) => {
      // Invalidate so real server data replaces the optimistic entry
      void qc.invalidateQueries({ queryKey: queryKeys.users.list() });
      push({
        type: 'success',
        title: 'User created',
        message: `${user.name} was added`,
      });
    },
  });
}

export function useReplaceUser() {
  const qc = useQueryClient();
  const push = useToastStore((s) => s.push);

  return useMutation({
    mutationFn: ({ id, data }: { id: string; data: ReplaceUserPayload }) =>
      replaceUser(id, data),

    onSuccess: (user) => {
      // Update both the list and the individual detail cache
      void qc.invalidateQueries({ queryKey: queryKeys.users.list() });
      qc.setQueryData(queryKeys.users.detail(user.id), user);
      push({
        type: 'info',
        title: 'User updated',
        message: `${user.name} was saved`,
      });
    },
  });
}

export function useDeleteUser() {
  const qc = useQueryClient();
  const push = useToastStore((s) => s.push);

  return useMutation({
    mutationFn: deleteUser,

    onSuccess: (_data, id) => {
      // Remove from list cache immediately without re-fetch
      qc.setQueryData(queryKeys.users.list(), (old: User[] = []) =>
        old.filter((u) => u.id !== id),
      );
      qc.removeQueries({ queryKey: queryKeys.users.detail(id) });
      push({ type: 'warning', title: 'User deleted' });
    },
  });
}

export function useUploadAvatar() {
  const qc = useQueryClient();
  const push = useToastStore((s) => s.push);

  return useMutation({
    mutationFn: ({ userId, file }: { userId: string; file: File }) =>
      uploadAvatar(userId, file),

    onSuccess: (url, { userId }) => {
      // Update the cached user object so avatarUrl is immediately available
      qc.setQueryData(queryKeys.users.list(), (old: User[] = []) =>
        old.map((u) => (u.id === userId ? { ...u, avatarUrl: url } : u)),
      );
      qc.setQueryData(
        queryKeys.users.detail(userId),
        (old: User | undefined) => (old ? { ...old, avatarUrl: url } : old),
      );
      push({ type: 'success', title: 'Avatar uploaded' });
    },

    onError: () => {
      push({ type: 'error', title: 'Avatar upload failed' });
    },
  });
}
