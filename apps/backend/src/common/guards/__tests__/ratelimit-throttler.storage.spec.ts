import { InMemoryRateLimitAdapter } from '../../../infrastructure/ratelimit/__tests__/in-memory-ratelimit.adapter';
import { RateLimitThrottlerStorage } from '../ratelimit-throttler.storage';

describe('RateLimitThrottlerStorage', () => {
  // Reproduces the gap: the throttler counted in process memory, so each
  // replica allowed the full limit and N replicas allowed N times as much.
  it('shares one count between replicas through the ratelimit store', async () => {
    const store = new InMemoryRateLimitAdapter();
    const replicaA = new RateLimitThrottlerStorage(store);
    const replicaB = new RateLimitThrottlerStorage(store);

    await expect(
      replicaA.increment('ip-1', 60_000, 2, 0, 'auth'),
    ).resolves.toMatchObject({ totalHits: 1, isBlocked: false });
    await expect(
      replicaB.increment('ip-1', 60_000, 2, 0, 'auth'),
    ).resolves.toMatchObject({ totalHits: 2, isBlocked: false });
    const third = await replicaA.increment('ip-1', 60_000, 2, 0, 'auth');
    expect(third.isBlocked).toBe(true);
    expect(third.totalHits).toBeGreaterThan(2);
    expect(third.timeToBlockExpire).toBeGreaterThan(0);
  });

  it('counts each throttler and tracker separately', async () => {
    const storage = new RateLimitThrottlerStorage(
      new InMemoryRateLimitAdapter(),
    );
    await storage.increment('ip-1', 60_000, 1, 0, 'auth');
    await expect(
      storage.increment('ip-1', 60_000, 1, 0, 'default'),
    ).resolves.toMatchObject({ isBlocked: false });
    await expect(
      storage.increment('ip-2', 60_000, 1, 0, 'auth'),
    ).resolves.toMatchObject({ isBlocked: false });
  });

  it('lets requests through when the store is unavailable', async () => {
    const storage = new RateLimitThrottlerStorage({
      hit: () => Promise.reject(new Error('down')),
      health: jest.fn(),
    });
    await expect(
      storage.increment('ip-1', 60_000, 1, 0, 'auth'),
    ).resolves.toMatchObject({ isBlocked: false });
  });
});
