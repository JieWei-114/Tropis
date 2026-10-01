import { assertPositiveInteger } from '../capability';
import type { RateLimitPolicy, RateLimitResult } from './ratelimit.port';

export function assertRateLimitPolicy(policy: RateLimitPolicy): void {
  assertPositiveInteger(policy?.limit, 'Rate limit `limit`');
  assertPositiveInteger(policy?.windowSeconds, 'Rate limit `windowSeconds`');
}

export function toRateLimitResult(
  policy: RateLimitPolicy,
  count: number,
  resetSeconds: number,
): RateLimitResult {
  return {
    allowed: count <= policy.limit,
    remaining: Math.max(0, policy.limit - count),
    resetSeconds,
  };
}
