import type { RateLimitKey } from '../../common/keyspace';
import type { HealthCheckable } from '../capability';

/**
 * Rate limit — fixed-window counters. A hit increments and reads the counter
 * and starts the window in one atomic step, so concurrent callers can never
 * exceed `limit` and a crash cannot leave a counter without an expiry.
 * One key belongs to one policy; reusing a key with another policy mixes
 * their counts.
 */
export const RATE_LIMIT = Symbol('RATE_LIMIT');

export interface RateLimitPolicy {
  /** Hits allowed per window. */
  limit: number;
  windowSeconds: number;
}

export interface RateLimitResult {
  allowed: boolean;
  /** Hits left in the current window (0 once exhausted). */
  remaining: number;
  /** Seconds until the current window ends. */
  resetSeconds: number;
}

export interface RateLimitPort extends HealthCheckable {
  hit(key: RateLimitKey, policy: RateLimitPolicy): Promise<RateLimitResult>;
}

export const RATE_LIMIT_ADAPTERS = ['redis', 'disabled'] as const;
export type RateLimitAdapterName = (typeof RATE_LIMIT_ADAPTERS)[number];
