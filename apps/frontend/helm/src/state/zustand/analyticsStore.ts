/**
 * ZUSTAND — Analytics Store
 *
 * Stores stats + recent events globally.
 * The live feed appends new events without re-fetching the whole list.
 */

import { create } from 'zustand';
import { devtools } from 'zustand/middleware';
import {
  fetchStats,
  fetchRecent,
  fireEvent,
  type AnalyticsStats,
  type AnalyticsEvent,
  type EventType,
} from '../../lib/api';

const MAX_LIVE = 30;

interface AnalyticsState {
  // ── State ──────────────────────────────────────────
  stats: AnalyticsStats | null;
  recent: AnalyticsEvent[];
  loading: boolean;
  error: string | null;

  // ── Actions ────────────────────────────────────────
  fetchAll: () => Promise<void>;
  fire: (type: EventType, userId: string) => Promise<void>;
  appendLive: (event: AnalyticsEvent) => void;
}

export const useAnalyticsStore = create<AnalyticsState>()(
  devtools(
    (set) => ({
      stats: null,
      recent: [],
      loading: false,
      error: null,

      fetchAll: async () => {
        set({ loading: true, error: null }, false, 'analytics/fetchAll:start');
        try {
          const [stats, recent] = await Promise.all([
            fetchStats(),
            fetchRecent(),
          ]);
          set(
            { stats, recent: recent.slice(0, MAX_LIVE), loading: false },
            false,
            'analytics/fetchAll:done',
          );
        } catch (e) {
          set(
            { error: (e as Error).message, loading: false },
            false,
            'analytics/fetchAll:error',
          );
        }
      },

      fire: async (type, userId) => {
        await fireEvent(type, userId);
        // Refetch stats after firing so totals are fresh
        const stats = await fetchStats().catch(() => null);
        if (stats) set({ stats }, false, 'analytics/fire:statsRefresh');
      },

      appendLive: (event) =>
        set(
          (state) => ({ recent: [event, ...state.recent].slice(0, MAX_LIVE) }),
          false,
          'analytics/appendLive',
        ),
    }),
    { name: 'AnalyticsStore' },
  ),
);
