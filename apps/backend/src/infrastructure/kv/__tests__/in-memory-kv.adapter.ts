import type { KvKey } from '../../../common/keyspace';
import { capabilityUp, type CapabilityHealth } from '../../capability';
import { InMemoryTtlMap } from '../../capability/__tests__/in-memory-ttl-map';
import { decodeKvValue, encodeKvValue, resolveKvLifetime } from '../kv.codec';
import type { KvPort, KvWriteOptions } from '../kv.port';

const FOREVER_MS = Number.MAX_SAFE_INTEGER / 2;

export class InMemoryKvAdapter implements KvPort {
  private readonly map = new InMemoryTtlMap<string>();

  get<T>(key: KvKey): Promise<T | undefined> {
    return Promise.resolve(decodeKvValue<T>(key, this.map.get(key) ?? null));
  }

  set<T>(key: KvKey, value: T, options: KvWriteOptions): Promise<void> {
    try {
      const ttl = resolveKvLifetime(options);
      this.map.set(
        key,
        encodeKvValue(value),
        ttl === null ? FOREVER_MS : ttl * 1000,
      );
      return Promise.resolve();
    } catch (err) {
      return Promise.reject(err as Error);
    }
  }

  del(key: KvKey): Promise<boolean> {
    return Promise.resolve(this.map.delete(key));
  }

  exists(key: KvKey): Promise<boolean> {
    return Promise.resolve(this.map.has(key));
  }

  health(): Promise<CapabilityHealth> {
    return Promise.resolve(capabilityUp('memory'));
  }
}
