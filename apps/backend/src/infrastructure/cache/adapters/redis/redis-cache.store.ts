import type Redis from 'ioredis';
import { probeCapability, type CapabilityHealth } from '../../../capability';
import type { CacheStore } from '../../cache.port';

export class RedisCacheStore implements CacheStore {
  constructor(private readonly redis: Redis) {}

  getRaw(key: string): Promise<string | null> {
    return this.redis.get(key);
  }

  async setRaw(key: string, value: string, ttlSeconds: number): Promise<void> {
    await this.redis.set(key, value, 'EX', ttlSeconds);
  }

  async del(key: string): Promise<void> {
    await this.redis.del(key);
  }

  health(): Promise<CapabilityHealth> {
    return probeCapability('redis', () => this.redis.ping());
  }
}
