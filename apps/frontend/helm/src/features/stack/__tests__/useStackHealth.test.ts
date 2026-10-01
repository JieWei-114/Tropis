import { renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest';

vi.mock('../../../lib/api', () => ({ getHealth: vi.fn() }));

import * as api from '../../../lib/api';
import { useStackHealth } from '../hooks/useStackHealth';

const getHealth = api.getHealth as Mock;

const statusOf = (
  services: Array<{ name: string; status: string }>,
  name: string,
) => services.find((s) => s.name === name)?.status;

describe('useStackHealth', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('reads capability checks and requires the adapter a card names', async () => {
    getHealth.mockResolvedValue({
      status: 'ok',
      degraded: [],
      checks: [
        { name: 'documents', status: 'up', adapter: 'mongo' },
        { name: 'cache', status: 'up', adapter: 'redis' },
        { name: 'messaging', status: 'up', adapter: 'kafka' },
        { name: 'graph', status: 'up', adapter: 'disabled', disabled: true },
        { name: 'search', status: 'down', adapter: 'elasticsearch' },
      ],
    });
    const { result } = renderHook(() => useStackHealth());
    await waitFor(() => expect(result.current.lastChecked).not.toBeNull());
    const s = result.current.services;
    expect(statusOf(s, 'backend')).toBe('up');
    expect(statusOf(s, 'mongo')).toBe('up');
    expect(statusOf(s, 'redis')).toBe('up');
    expect(statusOf(s, 'pulsar')).toBe('down');
    expect(statusOf(s, 'elasticsearch')).toBe('down');
  });

  it('reads the checks[] of a failing server, which name no adapters', async () => {
    getHealth.mockResolvedValue({
      status: 'error',
      degraded: [],
      checks: [
        { name: 'documents', status: 'down' },
        { name: 'cache', status: 'up' },
      ],
    });
    const { result } = renderHook(() => useStackHealth());
    await waitFor(() => expect(result.current.lastChecked).not.toBeNull());
    const s = result.current.services;
    expect(statusOf(s, 'mongo')).toBe('down');
    expect(statusOf(s, 'redis')).toBe('up');
  });

  it('marks everything unreachable when the backend cannot be reached', async () => {
    getHealth.mockRejectedValue(new TypeError('Failed to fetch'));
    const { result } = renderHook(() => useStackHealth());
    await waitFor(() =>
      expect(statusOf(result.current.services, 'redis')).toBe('unreachable'),
    );
  });
});
