import type { ReactNode } from 'react';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, it, vi, type Mock } from 'vitest';
import { ApiRequestError } from '@tropis/sdk';

vi.mock('../../../lib/api', () => ({
  getToken: vi.fn(() => null),
  getUserRoles: vi.fn(),
  setUserRoles: vi.fn(),
}));

import * as api from '../../../lib/api';
import { useUserRoles } from '../useUserRoles';

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

describe('useUserRoles', () => {
  it('reads the roles map through the SDK', async () => {
    (api.getUserRoles as Mock).mockResolvedValue({ u1: ['admin'] });
    const { result } = renderHook(() => useUserRoles(), { wrapper });
    await waitFor(() =>
      expect(result.current.rolesByUser).toEqual({ u1: ['admin'] }),
    );
  });

  it('surfaces the problem title of a rejected role change', async () => {
    (api.getUserRoles as Mock).mockResolvedValue({});
    (api.setUserRoles as Mock).mockRejectedValue(
      new ApiRequestError(409, {
        type: 'https://errors.tropis.dev/user-last-admin',
        title: 'The last admin of a tenant cannot be removed.',
        status: 409,
        code: 'USER_LAST_ADMIN',
      }),
    );
    const { result } = renderHook(() => useUserRoles(), { wrapper });

    let error: unknown;
    await act(async () => {
      error = await result.current.setRoles
        .mutateAsync({ id: 'u1', roles: ['viewer'] })
        .catch((e: unknown) => e);
    });

    expect((error as Error).message).toBe(
      'The last admin of a tenant cannot be removed.',
    );
  });
});
