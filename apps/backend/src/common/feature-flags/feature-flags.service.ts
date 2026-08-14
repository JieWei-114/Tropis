import { Injectable, Inject, Logger } from '@nestjs/common';
import type Redis from 'ioredis';
import { REDIS_CLIENT } from '../../infrastructure/redis/redis.module';

/**
 * Redis-backed feature flag store.
 *
 * Flags are stored as Redis hashes under the key `feature-flags`.
 * Value "1" = enabled, anything else / missing = disabled.
 *
 * Management:
 *   redis-cli HSET feature-flags new-checkout 1    # enable
 *   redis-cli HDEL feature-flags new-checkout      # disable
 */
@Injectable()
export class FeatureFlagsService {
  private readonly logger = new Logger(FeatureFlagsService.name);
  private readonly HASH_KEY = 'feature-flags';

  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  async isEnabled(flag: string): Promise<boolean> {
    try {
      const val = await this.redis.hget(this.HASH_KEY, flag);
      return val === '1';
    } catch (err) {
      this.logger.warn(
        `Feature flag check failed for "${flag}" — defaulting to disabled: ${(err as Error).message}`,
      );
      return false;
    }
  }

  async enable(flag: string): Promise<void> {
    await this.redis.hset(this.HASH_KEY, flag, '1');
  }

  async disable(flag: string): Promise<void> {
    await this.redis.hdel(this.HASH_KEY, flag);
  }

  async getAll(): Promise<Record<string, boolean>> {
    const raw = await this.redis.hgetall(this.HASH_KEY);
    return Object.fromEntries(
      Object.entries(raw).map(([k, v]) => [k, v === '1']),
    );
  }
}
