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
import type { LockPort } from '../lock.port';

const JOB = defineKey({
  capability: 'lock',
  module: 'conformance',
  name: 'job',
  version: 'v1',
});
const PROD_JOB = JOB.withKeyspace(KEYSPACE_PROD);

/** Behaviour every LockPort adapter must share. */
export function describeLockPort(
  adapter: string,
  target: ConformanceTarget<LockPort>,
): void {
  describe(`LockPort conformance: ${adapter}`, () => {
    let lock: LockPort;

    beforeAll(async () => {
      lock = await target.make();
    });

    afterAll(async () => {
      await target.teardown?.(lock);
    });

    it('reports up', async () => {
      expect((await lock.health()).status).toBe('up');
    });

    it('grants one lease at a time and frees it on release', async () => {
      const key = PROD_JOB.forTenant(TENANT_A, uniqueId());
      const lease = await lock.acquire(key, 5_000);
      expect(lease).not.toBeNull();
      expect(await lock.acquire(key, 5_000)).toBeNull();
      expect(await lease!.release()).toBe(true);
      expect(await lease!.release()).toBe(false);
      const next = await lock.acquire(key, 5_000);
      expect(next).not.toBeNull();
      expect(next!.token).not.toBe(lease!.token);
      await next!.release();
    });

    it('expires a lease that is not renewed', async () => {
      const key = PROD_JOB.forTenant(TENANT_A, uniqueId());
      expect(await lock.acquire(key, 300)).not.toBeNull();
      await sleep(600);
      const after = await lock.acquire(key, 5_000);
      expect(after).not.toBeNull();
      await after!.release();
    });

    it('renews while owned', async () => {
      const key = PROD_JOB.forTenant(TENANT_A, uniqueId());
      const lease = (await lock.acquire(key, 400))!;
      expect(await lease.renew(3_000)).toBe(true);
      await sleep(700);
      expect(await lock.acquire(key, 1_000)).toBeNull();
      await lease.release();
    });

    it('checks ownership: a stale holder cannot renew or release the new owner', async () => {
      const key = PROD_JOB.forTenant(TENANT_A, uniqueId());
      const stale = (await lock.acquire(key, 300))!;
      await sleep(600);
      const current = (await lock.acquire(key, 5_000))!;
      expect(current).not.toBeNull();
      expect(await stale.renew(5_000)).toBe(false);
      expect(await stale.release()).toBe(false);
      expect(await lock.acquire(key, 1_000)).toBeNull();
      expect(await current.release()).toBe(true);
    });

    it('lets exactly one of many concurrent callers win', async () => {
      const key = PROD_JOB.forTenant(TENANT_A, uniqueId());
      const leases = await Promise.all(
        Array.from({ length: 25 }, () => lock.acquire(key, 5_000)),
      );
      const winners = leases.filter((l) => l !== null);
      expect(winners).toHaveLength(1);
      await winners[0].release();
    });

    it('isolates tenants and environments', async () => {
      const id = uniqueId();
      const a = (await lock.acquire(PROD_JOB.forTenant(TENANT_A, id), 5_000))!;
      const b = await lock.acquire(PROD_JOB.forTenant(TENANT_B, id), 5_000);
      const staging = await lock.acquire(
        JOB.withKeyspace(KEYSPACE_STAGING).forTenant(TENANT_A, id),
        5_000,
      );
      expect(a).not.toBeNull();
      expect(b).not.toBeNull();
      expect(staging).not.toBeNull();
      await Promise.all([a.release(), b!.release(), staging!.release()]);
    });

    it('rejects an invalid TTL', async () => {
      const key = PROD_JOB.forTenant(TENANT_A, uniqueId());
      await expect(lock.acquire(key, 0)).rejects.toThrow(RangeError);
    });
  });
}
