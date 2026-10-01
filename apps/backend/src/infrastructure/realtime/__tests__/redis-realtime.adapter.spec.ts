import type Redis from 'ioredis';
import { toTenantId } from '../../../common/keyspace';
import { RedisRealtimeAdapter } from '../adapters/redis/redis-realtime.adapter';

describe('RedisRealtimeAdapter', () => {
  // Reproduces the misattribution: every send awaited one shared pending
  // list, so one caller's failed publish rejected another caller's send.
  it('settles each publish with its own result only', async () => {
    let failNext: (err: Error) => void = () => undefined;
    let calls = 0;
    const redis = {
      publish: jest.fn(() => {
        calls += 1;
        if (calls === 1) {
          return new Promise((_, reject) => (failNext = reject));
        }
        return Promise.resolve(1);
      }),
    } as unknown as Redis;
    const adapter = new RedisRealtimeAdapter(redis, 'socket.io');
    const acme = toTenantId('acme');

    const failing = adapter.publishToTenant(acme, 'a', {});
    const ok = adapter.publishToTenant(acme, 'b', {});
    failNext(new Error('redis down'));

    await expect(ok).resolves.toBeUndefined();
    await expect(failing).rejects.toThrow('redis down');
  });
});
