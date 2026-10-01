/**
 * WORKFLOWS FEATURE — reads the onboarding Temporal workflows from the backend
 * (`/api/workflows/onboarding`, through the SDK). Feeds the per-user follow-up badge (Users) and
 * the running/completed counts on the Stack page's Temporal row.
 */
import { useQuery } from '@tanstack/react-query';
import {
  listOnboardingWorkflows,
  type OnboardingWorkflows,
} from '../../lib/api';

const EMPTY: OnboardingWorkflows = {
  available: false,
  summary: { running: 0, completed: 0 },
  items: [],
};

export function useOnboardingWorkflows() {
  const query = useQuery({
    queryKey: ['workflows', 'onboarding'],
    queryFn: (): Promise<OnboardingWorkflows> => listOnboardingWorkflows(),
    staleTime: 10_000,
    // Stop polling once the endpoint answers "forbidden" — it will not change
    // for this user, and a 10s interval would re-fire it forever.
    retry: false,
    refetchInterval: (q) => (q.state.error ? false : 10_000),
  });

  const data = query.data ?? EMPTY;
  const byUser = new Map(data.items.map((w) => [w.userId, w]));
  return { ...query, data, byUser };
}
