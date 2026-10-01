import type { RateLimitKey } from '../../../common/keyspace';
import { capabilityUp, type CapabilityHealth } from '../../capability';
import { InMemoryTtlMap } from '../../capability/__tests__/in-memory-ttl-map';
import { assertRateLimitPolicy, toRateLimitResult } from '../ratelimit.policy';
import type {
  RateLimitPolicy,
  RateLimitPort,
  RateLimitResult,
} from '../ratelimit.port';

export class InMemoryRateLimitAdapter implements RateLimitPort {
  private readonly counters = new InMemoryTtlMap<number>();

  hit(key: RateLimitKey, policy: RateLimitPolicy): Promise<RateLimitResult> {
    try {
      assertRateLimitPolicy(policy);
    } catch (err) {
      return Promise.reject(err as Error);
    }
    const ttlMs = this.counters.ttlMs(key);
    const count = (this.counters.get(key) ?? 0) + 1;
    const windowMs = ttlMs ?? policy.windowSeconds * 1000;
    this.counters.set(key, count, windowMs);
    return Promise.resolve(
      toRateLimitResult(policy, count, Math.ceil(windowMs / 1000)),
    );
  }

  health(): Promise<CapabilityHealth> {
    return Promise.resolve(capabilityUp('memory'));
  }
}
