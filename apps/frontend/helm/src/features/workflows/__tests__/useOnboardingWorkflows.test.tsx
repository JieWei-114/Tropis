import type { ReactNode } from 'react';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, it, vi, type Mock } from 'vitest';

vi.mock('../../../lib/api', () => ({
  listOnboardingWorkflows: vi.fn(),
}));

import * as api from '../../../lib/api';
import { useOnboardingWorkflows } from '../useOnboardingWorkflows';

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

describe('useOnboardingWorkflows', () => {
  it('indexes executions by user and keeps the ISO timestamps', async () => {
    (api.listOnboardingWorkflows as Mock).mockResolvedValue({
      available: true,
      summary: { running: 1, completed: 0 },
      items: [
        {
          workflowId: 'onboarding-u1',
          userId: 'u1',
          status: 'RUNNING',
          startTime: '2026-09-30T08:15:00.000Z',
          closeTime: null,
        },
      ],
    });
    const { result } = renderHook(() => useOnboardingWorkflows(), { wrapper });
    await waitFor(() => expect(result.current.data.available).toBe(true));
    expect(result.current.byUser.get('u1')).toMatchObject({
      status: 'RUNNING',
      startTime: '2026-09-30T08:15:00.000Z',
      closeTime: null,
    });
  });

  it('reports unavailable with no executions before the first answer', () => {
    (api.listOnboardingWorkflows as Mock).mockReturnValue(
      new Promise(() => undefined),
    );
    const { result } = renderHook(() => useOnboardingWorkflows(), { wrapper });
    expect(result.current.data).toEqual({
      available: false,
      summary: { running: 0, completed: 0 },
      items: [],
    });
    expect(result.current.byUser.size).toBe(0);
  });
});
