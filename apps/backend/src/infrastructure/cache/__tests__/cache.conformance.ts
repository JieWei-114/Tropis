import { defineKey } from '../../../common/keyspace';
import {
  KEYSPACE_PROD,
  KEYSPACE_STAGING,
  sleep,
  TENANT_A,
  TENANT_B,
  uniqueId,
  type ConformanceTarget,
} from '../../capability/__tests__/conformance-helpers';
import type { CachePort } from '../cache.port';

const ITEM = defineKey({
  capability: 'cache',
  module: 'conformance',
  name: 'item',
  version: 'v1',
});
const PROD_ITEM = ITEM.withKeyspace(KEYSPACE_PROD);

/** Behaviour every CachePort adapter must share. */
export function describeCachePort(
  adapter: string,
  target: ConformanceTarget<CachePort>,
): void {
  describe(`CachePort conformance: ${adapter}`, () => {
    let cache: CachePort;

    beforeAll(async () => {
      cache = await target.make();
    });

    afterAll(async () => {
      await target.teardown?.(cache);
    });

    it('reports up', async () => {
      expect((await cache.health()).status).toBe('up');
    });

    it('round-trips JSON values and misses with undefined', async () => {
      const key = PROD_ITEM.forTenant(TENANT_A, uniqueId());
      expect(await cache.get(key)).toBeUndefined();
      const value = { name: 'a', n: 1, nested: [true, null] };
      await cache.set(key, value, 30);
      expect(await cache.get(key)).toEqual(value);
      await cache.set(key, null, 30);
      expect(await cache.get(key)).toBeNull();
      await cache.del(key);
      expect(await cache.get(key)).toBeUndefined();
    });

    it('expires values after their TTL', async () => {
      const key = PROD_ITEM.forTenant(TENANT_A, uniqueId());
      await cache.set(key, 'short', 1);
      expect(await cache.get(key)).toBe('short');
      await sleep(1_600);
      expect(await cache.get(key)).toBeUndefined();
    });

    it('rejects a missing or invalid TTL', async () => {
      const key = PROD_ITEM.forTenant(TENANT_A, uniqueId());
      await expect(cache.set(key, 1, 0)).rejects.toThrow(RangeError);
      await expect(cache.set(key, 1, 1.5)).rejects.toThrow(RangeError);
      await expect(
        cache.set(key, 1, undefined as unknown as number),
      ).rejects.toThrow(RangeError);
      await expect(
        cache.getOrLoad(key, -1, () => Promise.resolve(1)),
      ).rejects.toThrow(RangeError);
    });

    it('isolates tenants and environments', async () => {
      const id = uniqueId();
      const a = PROD_ITEM.forTenant(TENANT_A, id);
      const b = PROD_ITEM.forTenant(TENANT_B, id);
      const global = PROD_ITEM.global(id);
      const staging = ITEM.withKeyspace(KEYSPACE_STAGING).forTenant(
        TENANT_A,
        id,
      );
      await cache.set(a, 'a', 30);
      expect(await cache.get(b)).toBeUndefined();
      expect(await cache.get(global)).toBeUndefined();
      expect(await cache.get(staging)).toBeUndefined();
      await cache.set(staging, 'staging', 30);
      expect(await cache.get(a)).toBe('a');
    });

    it('runs the loader once for concurrent misses (single-flight)', async () => {
      const key = PROD_ITEM.forTenant(TENANT_A, uniqueId());
      let calls = 0;
      const loader = async () => {
        calls += 1;
        await sleep(100);
        return { loaded: calls };
      };
      const results = await Promise.all(
        Array.from({ length: 20 }, () => cache.getOrLoad(key, 30, loader)),
      );
      expect(calls).toBe(1);
      expect(new Set(results.map((r) => r.loaded))).toEqual(new Set([1]));
      expect(await cache.getOrLoad(key, 30, loader)).toEqual({ loaded: 1 });
      expect(calls).toBe(1);
    });

    it('shares a loader failure with every waiter and does not cache it', async () => {
      const key = PROD_ITEM.forTenant(TENANT_A, uniqueId());
      let calls = 0;
      const failing = async () => {
        calls += 1;
        await sleep(50);
        throw new Error('loader failed');
      };
      const outcomes = await Promise.allSettled(
        Array.from({ length: 5 }, () => cache.getOrLoad(key, 30, failing)),
      );
      expect(calls).toBe(1);
      expect(outcomes.every((o) => o.status === 'rejected')).toBe(true);
      expect(
        await cache.getOrLoad(key, 30, () => Promise.resolve('recovered')),
      ).toBe('recovered');
    });
  });
}
