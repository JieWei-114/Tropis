import { defineKey } from '../../../common/keyspace';
import { CapabilityDisabledError } from '../../capability';
import { DisabledRateLimitAdapter } from '../adapters/disabled/disabled-ratelimit.adapter';
import type { RateLimitPort } from '../ratelimit.port';
import { InMemoryRateLimitAdapter } from './in-memory-ratelimit.adapter';
import { describeRateLimitPort } from './ratelimit.conformance';

describeRateLimitPort('in-memory fake', {
  make: () => new InMemoryRateLimitAdapter(),
});

describe('DisabledRateLimitAdapter', () => {
  it('throws CapabilityDisabledError and reports disabled', async () => {
    const limiter: RateLimitPort = new DisabledRateLimitAdapter();
    const key = defineKey({
      capability: 'ratelimit',
      module: 'test',
      name: 'login-attempt',
      version: 'v1',
    }).global();
    await expect(
      limiter.hit(key, { limit: 1, windowSeconds: 1 }),
    ).rejects.toBeInstanceOf(CapabilityDisabledError);
    expect((await limiter.health()).status).toBe('disabled');
  });
});
