import { capabilityUp, type CapabilityHealth } from '../../capability';
import { InMemoryTtlMap } from '../../capability/__tests__/in-memory-ttl-map';
import type { CacheStore } from '../cache.port';

export class InMemoryCacheStore implements CacheStore {
  private readonly map = new InMemoryTtlMap<string>();

  getRaw(key: string): Promise<string | null> {
    return Promise.resolve(this.map.get(key) ?? null);
  }

  setRaw(key: string, value: string, ttlSeconds: number): Promise<void> {
    this.map.set(key, value, ttlSeconds * 1000);
    return Promise.resolve();
  }

  del(key: string): Promise<void> {
    this.map.delete(key);
    return Promise.resolve();
  }

  health(): Promise<CapabilityHealth> {
    return Promise.resolve(capabilityUp('memory'));
  }
}
