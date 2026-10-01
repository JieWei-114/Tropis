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
import type { KvPort, KvWriteOptions } from '../kv.port';

const ITEM = defineKey({
  capability: 'kv',
  module: 'conformance',
  name: 'item',
  version: 'v1',
});
const PROD_ITEM = ITEM.withKeyspace(KEYSPACE_PROD);

/** Behaviour every KvPort adapter must share. */
export function describeKvPort(
  adapter: string,
  target: ConformanceTarget<KvPort>,
): void {
  describe(`KvPort conformance: ${adapter}`, () => {
    let kv: KvPort;

    beforeAll(async () => {
      kv = await target.make();
    });

    afterAll(async () => {
      await target.teardown?.(kv);
    });

    it('reports up', async () => {
      expect((await kv.health()).status).toBe('up');
    });

    it('supports get/set/exists/del', async () => {
      const key = PROD_ITEM.forTenant(TENANT_A, uniqueId());
      expect(await kv.get(key)).toBeUndefined();
      expect(await kv.exists(key)).toBe(false);
      await kv.set(key, { state: 'on', count: 2 }, { ttlSeconds: 60 });
      expect(await kv.get(key)).toEqual({ state: 'on', count: 2 });
      expect(await kv.exists(key)).toBe(true);
      expect(await kv.del(key)).toBe(true);
      expect(await kv.del(key)).toBe(false);
      expect(await kv.exists(key)).toBe(false);
    });

    it('expires values with a TTL', async () => {
      const key = PROD_ITEM.forTenant(TENANT_A, uniqueId());
      await kv.set(key, 'short', { ttlSeconds: 1 });
      expect(await kv.get(key)).toBe('short');
      await sleep(2_200);
      expect(await kv.get(key)).toBeUndefined();
      expect(await kv.exists(key)).toBe(false);
    });

    it('keeps persistent values and lets persistent clear an earlier TTL', async () => {
      const key = PROD_ITEM.forTenant(TENANT_A, uniqueId());
      await kv.set(key, 'first', { ttlSeconds: 1 });
      await kv.set(key, 'kept', { persistent: true });
      await sleep(2_200);
      expect(await kv.get(key)).toBe('kept');
      await kv.del(key);
    });

    it('requires an explicit lifetime', async () => {
      const key = PROD_ITEM.forTenant(TENANT_A, uniqueId());
      const invalid: unknown[] = [
        {},
        { ttlSeconds: 0 },
        { ttlSeconds: 2.5 },
        { persistent: false },
        { persistent: true, ttlSeconds: 5 },
        undefined,
      ];
      for (const options of invalid) {
        await expect(
          kv.set(key, 1, options as KvWriteOptions),
        ).rejects.toThrow();
      }
      expect(await kv.exists(key)).toBe(false);
    });

    it('isolates tenants and environments', async () => {
      const id = uniqueId();
      const a = PROD_ITEM.forTenant(TENANT_A, id);
      const b = PROD_ITEM.forTenant(TENANT_B, id);
      const staging = ITEM.withKeyspace(KEYSPACE_STAGING).forTenant(
        TENANT_A,
        id,
      );
      await kv.set(a, 'a', { ttlSeconds: 60 });
      expect(await kv.exists(b)).toBe(false);
      expect(await kv.exists(PROD_ITEM.global(id))).toBe(false);
      expect(await kv.exists(staging)).toBe(false);
      await kv.set(b, 'b', { ttlSeconds: 60 });
      expect(await kv.get(a)).toBe('a');
      expect(await kv.get(b)).toBe('b');
    });
  });
}
