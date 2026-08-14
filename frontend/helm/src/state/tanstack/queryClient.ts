/**
 * TANSTACK QUERY — Query Client
 *
 * Central config for all queries in the app.
 * QueryClient manages the cache, background refetch, and deduplication.
 *
 * Key concepts:
 *   staleTime    — how long cached data is considered fresh (no refetch)
 *   gcTime       — how long unused cache entries are kept in memory
 *   retry        — how many times to retry on error
 *   refetchOnWindowFocus — refetch when user tabs back to the window
 */

import { QueryClient } from '@tanstack/react-query';

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000, // data is fresh for 30s — no background refetch within this window
      gcTime: 5 * 60_000, // keep unused cache for 5 min
      retry: 2,
      refetchOnWindowFocus: true, // refetch when user switches back to tab (great UX)
    },
    mutations: {
      retry: 0,
    },
  },
});

/**
 * Query Keys — centralised so invalidation is consistent everywhere.
 *
 * Pattern: ['resource', 'action', ...params]
 * Invalidating ['users'] will bust ALL user queries (list + individual).
 */
export const queryKeys = {
  users: {
    all: () => ['users'] as const,
    list: () => ['users', 'list'] as const,
    detail: (id: string) => ['users', 'detail', id] as const,
    search: (q: string) => ['users', 'search', q] as const,
    similar: (id: string) => ['users', 'similar', id] as const,
  },
  analytics: {
    all: () => ['analytics'] as const,
    stats: () => ['analytics', 'stats'] as const,
    recent: () => ['analytics', 'recent'] as const,
    minutely: (m: number) => ['analytics', 'minutely', m] as const,
  },
};
