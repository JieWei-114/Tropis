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
import type {
  RateLimitPolicy,
  RateLimitPort,
  RateLimitResult,
} from '../ratelimit.port';

const LOGIN = defineKey({
  capability: 'ratelimit',
  module: 'conformance',
  name: 'login-attempt',
  version: 'v1',
});
const PROD_LOGIN = LOGIN.withKeyspace(KEYSPACE_PROD);

/** Behaviour every RateLimitPort adapter must share. */
export function describeRateLimitPort(
  adapter: string,
  target: ConformanceTarget<RateLimitPort>,
): void {
  describe(`RateLimitPort conformance: ${adapter}`, () => {
    let limiter: RateLimitPort;

    beforeAll(async () => {
      limiter = await target.make();
    });

    afterAll(async () => {
      await target.teardown?.(limiter);
    });

    it('reports up', async () => {
      expect((await limiter.health()).status).toBe('up');
    });

    it('allows `limit` hits per window, then denies', async () => {
      const key = PROD_LOGIN.forTenant(TENANT_A, uniqueId());
      const policy = { limit: 3, windowSeconds: 30 };
      const results: RateLimitResult[] = [];
      for (let i = 0; i < 5; i += 1)
        results.push(await limiter.hit(key, policy));
      expect(results.map((r) => r.allowed)).toEqual([
        true,
        true,
        true,
        false,
        false,
      ]);
      expect(results.map((r) => r.remaining)).toEqual([2, 1, 0, 0, 0]);
      for (const r of results) {
        expect(r.resetSeconds).toBeGreaterThan(0);
        expect(r.resetSeconds).toBeLessThanOrEqual(30);
      }
    });

    it('is atomic under concurrency', async () => {
      const key = PROD_LOGIN.forTenant(TENANT_A, uniqueId());
      const policy = { limit: 10, windowSeconds: 30 };
      const results = await Promise.all(
        Array.from({ length: 60 }, () => limiter.hit(key, policy)),
      );
      expect(results.filter((r) => r.allowed)).toHaveLength(10);
      const remaining = results.map((r) => r.remaining).sort((a, b) => b - a);
      expect(remaining.slice(0, 10)).toEqual([9, 8, 7, 6, 5, 4, 3, 2, 1, 0]);
    });

    it('starts a new window once the old one expires', async () => {
      const key = PROD_LOGIN.forTenant(TENANT_A, uniqueId());
      const policy = { limit: 1, windowSeconds: 1 };
      expect((await limiter.hit(key, policy)).allowed).toBe(true);
      expect((await limiter.hit(key, policy)).allowed).toBe(false);
      await sleep(1_600);
      expect((await limiter.hit(key, policy)).allowed).toBe(true);
    });

    it('isolates tenants and environments', async () => {
      const id = uniqueId();
      const policy = { limit: 1, windowSeconds: 30 };
      expect(
        (await limiter.hit(PROD_LOGIN.forTenant(TENANT_A, id), policy)).allowed,
      ).toBe(true);
      expect(
        (await limiter.hit(PROD_LOGIN.forTenant(TENANT_B, id), policy)).allowed,
      ).toBe(true);
      expect(
        (
          await limiter.hit(
            LOGIN.withKeyspace(KEYSPACE_STAGING).forTenant(TENANT_A, id),
            policy,
          )
        ).allowed,
      ).toBe(true);
      expect(
        (await limiter.hit(PROD_LOGIN.forTenant(TENANT_A, id), policy)).allowed,
      ).toBe(false);
    });

    it('rejects an invalid policy', async () => {
      const key = PROD_LOGIN.forTenant(TENANT_A, uniqueId());
      const invalid: RateLimitPolicy[] = [
        { limit: 0, windowSeconds: 1 },
        { limit: 1, windowSeconds: 0 },
        { limit: 1.5, windowSeconds: 1 },
      ];
      for (const policy of invalid) {
        await expect(limiter.hit(key, policy)).rejects.toThrow(RangeError);
      }
    });
  });
}
