import type Redis from 'ioredis';
import type { KvKey } from '../../../../common/keyspace';
import { probeCapability, type CapabilityHealth } from '../../../capability';
import {
  decodeKvValue,
  encodeKvValue,
  resolveKvLifetime,
} from '../../kv.codec';
import type { KvPort, KvWriteOptions } from '../../kv.port';

export class RedisKvAdapter implements KvPort {
  constructor(private readonly redis: Redis) {}

  async get<T>(key: KvKey): Promise<T | undefined> {
    return decodeKvValue<T>(key, await this.redis.get(key));
  }

  async set<T>(key: KvKey, value: T, options: KvWriteOptions): Promise<void> {
    const ttl = resolveKvLifetime(options);
    const encoded = encodeKvValue(value);
    // A plain SET drops any previous TTL, which is exactly `persistent`.
    if (ttl === null) await this.redis.set(key, encoded);
    else await this.redis.set(key, encoded, 'EX', ttl);
  }

  async del(key: KvKey): Promise<boolean> {
    return (await this.redis.del(key)) > 0;
  }

  async exists(key: KvKey): Promise<boolean> {
    return (await this.redis.exists(key)) > 0;
  }

  health(): Promise<CapabilityHealth> {
    return probeCapability('redis', () => this.redis.ping());
  }
}
