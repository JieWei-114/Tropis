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
  it('reads every page of the roles listing into one map', async () => {
    (api.getUserRoles as Mock)
      .mockResolvedValueOnce({
        items: [{ userId: 'u1', roles: ['admin'] }],
        nextPageToken: 'next',
        totalSize: 2,
      })
      .mockResolvedValueOnce({
        items: [{ userId: 'u2', roles: ['viewer'] }],
        nextPageToken: '',
        totalSize: 2,
      });
    const { result } = renderHook(() => useUserRoles(), { wrapper });
    await waitFor(() =>
      expect(result.current.rolesByUser).toEqual({
        u1: ['admin'],
        u2: ['viewer'],
      }),
    );
    expect(api.getUserRoles).toHaveBeenNthCalledWith(1, {
      pageSize: 100,
      pageToken: '',
    });
    expect(api.getUserRoles).toHaveBeenNthCalledWith(2, {
      pageSize: 100,
      pageToken: 'next',
    });
  });

  it('stops when the server repeats a page token', async () => {
    (api.getUserRoles as Mock).mockReset().mockResolvedValue({
      items: [{ userId: 'u1', roles: ['admin'] }],
      nextPageToken: 'same',
      totalSize: 9,
    });
    const { result } = renderHook(() => useUserRoles(), { wrapper });
    await waitFor(() =>
      expect(result.current.rolesByUser).toEqual({ u1: ['admin'] }),
    );
    expect(api.getUserRoles).toHaveBeenCalledTimes(2);
  });

  it('surfaces the problem title of a rejected role change', async () => {
    (api.getUserRoles as Mock).mockResolvedValue({
      items: [],
      nextPageToken: '',
      totalSize: 0,
    });
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
