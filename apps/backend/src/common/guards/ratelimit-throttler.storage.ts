import type { ThrottlerStorage } from '@nestjs/throttler';

type ThrottlerStorageRecord = Awaited<
  ReturnType<ThrottlerStorage['increment']>
>;
import { defineKey } from '../keyspace';
import { createLogger } from '../observability/logger';
import type { RateLimitPort } from '../../infrastructure/ratelimit/ratelimit.port';

/** HTTP throttler counters: global(throttlerName, trackerKey). */
export const HTTP_THROTTLE_KEY = defineKey({
  capability: 'ratelimit',
  module: 'http',
  name: 'throttle',
  version: 'v1',
});

/**
 * ThrottlerStorage over the ratelimit capability, so the HTTP limits are
 * counted in the shared store and hold across every replica instead of per
 * process. A window's hits beyond the limit are blocked until it ends. When
 * the store is unavailable a request is let through (logged), as the login
 * lockout does: an unreachable store must not take the whole API down.
 */
export class RateLimitThrottlerStorage implements ThrottlerStorage {
  private readonly logger = createLogger('http');
  private warned = false;

  constructor(private readonly rateLimit: RateLimitPort) {}

  async increment(
    key: string,
    ttl: number,
    limit: number,
    _blockDuration: number,
    throttlerName: string,
  ): Promise<ThrottlerStorageRecord> {
    const windowSeconds = Math.max(1, Math.ceil(ttl / 1000));
    try {
      const result = await this.rateLimit.hit(
        HTTP_THROTTLE_KEY.global(throttlerName, key),
        { limit, windowSeconds },
      );
      this.warned = false;
      return {
        totalHits: result.allowed ? limit - result.remaining : limit + 1,
        timeToExpire: result.resetSeconds,
        isBlocked: !result.allowed,
        timeToBlockExpire: result.allowed ? 0 : result.resetSeconds,
      };
    } catch (err) {
      if (!this.warned) {
        this.warned = true;
        this.logger.warn(
          'throttle-store-unavailable',
          'HTTP rate limit store unavailable; requests are not rate limited until it is back',
          {},
          err,
        );
      }
      return {
        totalHits: 0,
        timeToExpire: windowSeconds,
        isBlocked: false,
        timeToBlockExpire: 0,
      };
    }
  }
}
