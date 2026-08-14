/**
 * TANSTACK QUERY — Analytics Queries & Mutations
 *
 * Demonstrates:
 *   - useQueries: fetch stats + recent in parallel
 *   - useMutation with side-effect invalidation
 *   - staleTime per-query (minutely data stays fresh longer)
 */

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  fetchStats,
  fetchRecent,
  fetchMinutelyStats,
  fireEvent,
  type EventType,
} from '../../lib/api';
import { queryKeys } from './queryClient';
import { useToastStore } from '../zustand/toastStore';

// ── Stats (ClickHouse — cached 30s) ───────────────────────────────────────────
export function useAnalyticsStats() {
  return useQuery({
    queryKey: queryKeys.analytics.stats(),
    queryFn: fetchStats,
    // staleTime from default — refetches after 30s or on window focus
  });
}

// ── Recent events (MongoDB — refresh often) ───────────────────────────────────
export function useRecentEvents() {
  return useQuery({
    queryKey: queryKeys.analytics.recent(),
    queryFn: fetchRecent,
    staleTime: 5_000, // recent events go stale faster than stats
    refetchInterval: 5_000, // poll every 5s even when window is focused
  });
}

// ── Minutely chart (ClickHouse materialized view) ────────────────────────────
export function useMinutelyStats(minutes = 60) {
  return useQuery({
    queryKey: queryKeys.analytics.minutely(minutes),
    queryFn: () => fetchMinutelyStats(minutes),
    staleTime: 60_000, // minute-buckets only change once per minute
    refetchInterval: 60_000,
  });
}

// ── Fire event mutation ───────────────────────────────────────────────────────
export function useFireEvent() {
  const qc = useQueryClient();
  const push = useToastStore((s) => s.push);

  return useMutation({
    mutationFn: ({ type, userId }: { type: EventType; userId: string }) =>
      fireEvent(type, userId),

    onSuccess: (event) => {
      // Invalidate stats so chart updates after firing
      // TanStack will refetch in background — no loading spinner shown
      void qc.invalidateQueries({ queryKey: queryKeys.analytics.stats() });
      void qc.invalidateQueries({ queryKey: queryKeys.analytics.recent() });
      push({ type: 'success', title: `Event fired: ${event.eventType}` });
    },
  });
}
