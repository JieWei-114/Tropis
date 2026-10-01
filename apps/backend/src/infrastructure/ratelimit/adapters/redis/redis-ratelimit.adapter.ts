import type Redis from 'ioredis';
import type { RateLimitKey } from '../../../../common/keyspace';
import { probeCapability, type CapabilityHealth } from '../../../capability';
import type {
  RateLimitPolicy,
  RateLimitPort,
  RateLimitResult,
} from '../../ratelimit.port';
import {
  assertRateLimitPolicy,
  toRateLimitResult,
} from '../../ratelimit.policy';

/**
 * INCR, then start the window if the key has no expiry (first hit, or a key
 * left without one). Runs as one script, so it is atomic.
 */
const HIT = `
local count = redis.call("incr", KEYS[1])
local ttl = redis.call("ttl", KEYS[1])
if ttl < 0 then
  redis.call("expire", KEYS[1], ARGV[1])
  ttl = tonumber(ARGV[1])
end
return {count, ttl}
`;

export class RedisRateLimitAdapter implements RateLimitPort {
  constructor(private readonly redis: Redis) {}

  async hit(
    key: RateLimitKey,
    policy: RateLimitPolicy,
  ): Promise<RateLimitResult> {
    assertRateLimitPolicy(policy);
    const [count, ttl] = (await this.redis.eval(
      HIT,
      1,
      key,
      String(policy.windowSeconds),
    )) as [number, number];
    return toRateLimitResult(policy, count, ttl);
  }

  health(): Promise<CapabilityHealth> {
    return probeCapability('redis', () => this.redis.ping());
  }
}
