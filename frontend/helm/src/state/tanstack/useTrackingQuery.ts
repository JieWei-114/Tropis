/**
 * TANSTACK QUERY — Tracking insights (user-behavior dashboard).
 * Server data via the SDK's gRPC TrackingService.GetInsights.
 */

import { useQuery } from '@tanstack/react-query';
import { api } from '../../lib/api';

export const trackingKeys = {
  insights: (days: number) => ['tracking', 'insights', days] as const,
};

export function useTrackingInsights(days = 7) {
  return useQuery({
    queryKey: trackingKeys.insights(days),
    queryFn: () => api.fetchTrackingInsights(days),
    staleTime: 15_000,
    refetchInterval: 15_000, // behavior feed stays reasonably live
  });
}
