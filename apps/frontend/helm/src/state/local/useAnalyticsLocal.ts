/**
 * LOCAL STATE — Analytics hook
 *
 * Fetches stats + recent events with local useState/useEffect.
 * Demonstrates the classic pattern before introducing TanStack Query.
 */

import { useState, useEffect, useCallback } from 'react';
import {
  fetchStats,
  fetchRecent,
  type AnalyticsStats,
  type AnalyticsEvent,
} from '../../lib/api';

export function useAnalyticsLocal() {
  const [stats, setStats] = useState<AnalyticsStats | null>(null);
  const [recent, setRecent] = useState<AnalyticsEvent[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [s, r] = await Promise.all([fetchStats(), fetchRecent()]);
      setStats(s);
      setRecent(r);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load analytics');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return { stats, recent, loading, error, refetch: load };
}
