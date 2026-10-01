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
import type { DedupPort } from '../dedup.port';

const EVENT = defineKey({
  capability: 'dedup',
  module: 'conformance',
  name: 'processed-event',
  version: 'v1',
});
const PROD_EVENT = EVENT.withKeyspace(KEYSPACE_PROD);

/** Behaviour every DedupPort adapter must share. */
export function describeDedupPort(
  adapter: string,
  target: ConformanceTarget<DedupPort>,
): void {
  describe(`DedupPort conformance: ${adapter}`, () => {
    let dedup: DedupPort;

    beforeAll(async () => {
      dedup = await target.make();
    });

    afterAll(async () => {
      await target.teardown?.(dedup);
    });

    it('reports up', async () => {
      expect((await dedup.health()).status).toBe('up');
    });

    it('claims once until released', async () => {
      const key = PROD_EVENT.forTenant(TENANT_A, uniqueId());
      expect(await dedup.claim(key, 30)).toBe(true);
      expect(await dedup.claim(key, 30)).toBe(false);
      await dedup.release(key);
      expect(await dedup.claim(key, 30)).toBe(true);
    });

    it('frees the claim after its TTL', async () => {
      const key = PROD_EVENT.forTenant(TENANT_A, uniqueId());
      expect(await dedup.claim(key, 1)).toBe(true);
      await sleep(1_600);
      expect(await dedup.claim(key, 30)).toBe(true);
    });

    it('extends an existing claim only', async () => {
      const key = PROD_EVENT.forTenant(TENANT_A, uniqueId());
      expect(await dedup.extend(key, 30)).toBe(false);
      expect(await dedup.claim(key, 1)).toBe(true);
      expect(await dedup.extend(key, 30)).toBe(true);
      await sleep(1_600);
      expect(await dedup.claim(key, 30)).toBe(false);
    });

    it('lets exactly one of many concurrent claims win', async () => {
      const key = PROD_EVENT.forTenant(TENANT_A, uniqueId());
      const results = await Promise.all(
        Array.from({ length: 30 }, () => dedup.claim(key, 30)),
      );
      expect(results.filter(Boolean)).toHaveLength(1);
    });

    it('isolates tenants and environments', async () => {
      const id = uniqueId();
      expect(await dedup.claim(PROD_EVENT.forTenant(TENANT_A, id), 30)).toBe(
        true,
      );
      expect(await dedup.claim(PROD_EVENT.forTenant(TENANT_B, id), 30)).toBe(
        true,
      );
      expect(
        await dedup.claim(
          EVENT.withKeyspace(KEYSPACE_STAGING).forTenant(TENANT_A, id),
          30,
        ),
      ).toBe(true);
      expect(await dedup.claim(PROD_EVENT.global(id), 30)).toBe(true);
    });

    it('lets only the owner extend or release its claim', async () => {
      const key = PROD_EVENT.forTenant(TENANT_A, uniqueId());
      expect(await dedup.claim(key, 30, 'attempt-1')).toBe(true);
      expect(await dedup.extend(key, 30, 'attempt-2')).toBe(false);
      expect(await dedup.release(key, 'attempt-2')).toBe(false);
      expect(await dedup.claim(key, 30, 'attempt-2')).toBe(false);
      expect(await dedup.extend(key, 30, 'attempt-1')).toBe(true);
      expect(await dedup.release(key, 'attempt-1')).toBe(true);
      expect(await dedup.claim(key, 30, 'attempt-2')).toBe(true);
    });

    it('does not release a claim taken over after the owner expired', async () => {
      const key = PROD_EVENT.forTenant(TENANT_A, uniqueId());
      expect(await dedup.claim(key, 1, 'slow')).toBe(true);
      await sleep(1_600);
      expect(await dedup.claim(key, 30, 'fast')).toBe(true);
      expect(await dedup.release(key, 'slow')).toBe(false);
      expect(await dedup.claim(key, 30, 'other')).toBe(false);
    });

    it('claims, extends and releases many keys in one call', async () => {
      const keys = [uniqueId(), uniqueId(), uniqueId()].map((id) =>
        PROD_EVENT.forTenant(TENANT_A, id),
      );
      expect(await dedup.claim(keys[1], 30, 'x')).toBe(true);
      expect(await dedup.claimMany(keys, 30, 'batch')).toEqual([
        true,
        false,
        true,
      ]);
      expect(await dedup.extendMany(keys, 60, 'batch')).toEqual([
        true,
        false,
        true,
      ]);
      expect(await dedup.releaseMany(keys, 'batch')).toEqual([
        true,
        false,
        true,
      ]);
      expect(await dedup.claimMany([], 30)).toEqual([]);
      expect(await dedup.claimMany(keys, 30, 'again')).toEqual([
        true,
        false,
        true,
      ]);
    });

    it('rejects an invalid TTL', async () => {
      const key = PROD_EVENT.forTenant(TENANT_A, uniqueId());
      await expect(dedup.claim(key, 0)).rejects.toThrow(RangeError);
      await expect(dedup.extend(key, -1)).rejects.toThrow(RangeError);
    });
  });
}
