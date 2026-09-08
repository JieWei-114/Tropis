/**
 * WORKFLOWS FEATURE — reads the onboarding Temporal workflows from the backend
 * (`/api/workflows/onboarding`). Feeds the per-user follow-up badge (Users) and
 * the running/completed counts on the Stack page's Temporal row.
 */
import { useQuery } from '@tanstack/react-query';
import { env } from '../../lib/env';
import { getToken } from '../../lib/api';

const URL = `${env.VITE_API_BASE_URL}/api/workflows/onboarding`;

interface OnboardingWorkflow {
  workflowId: string;
  userId: string;
  status: string; // 'RUNNING' | 'COMPLETED' | 'FAILED' | …
  startTime: number | null;
  closeTime: number | null;
}

interface OnboardingResponse {
  available: boolean;
  summary: { running: number; completed: number };
  items: OnboardingWorkflow[];
}

const EMPTY: OnboardingResponse = {
  available: false,
  summary: { running: 0, completed: 0 },
  items: [],
};

export function useOnboardingWorkflows() {
  const query = useQuery({
    queryKey: ['workflows', 'onboarding'],
    queryFn: async (): Promise<OnboardingResponse> => {
      const token = getToken();
      const res = await fetch(URL, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (!res.ok) throw new Error(`onboarding ${res.status}`);
      return (await res.json()) as OnboardingResponse;
    },
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
