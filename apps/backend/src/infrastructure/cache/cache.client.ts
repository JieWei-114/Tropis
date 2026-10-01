import type { CacheKey } from '../../common/keyspace';
import { createLogger } from '../../common/observability/logger';
import {
  assertPositiveInteger,
  CapabilityDisabledError,
  type CapabilityHealth,
} from '../capability';
import { decodeCacheValue, encodeCacheValue } from './cache.codec';
import type { CachePort, CacheStore } from './cache.port';

/** CachePort over any CacheStore: codec, TTL checks and single-flight. */
export class CacheClient implements CachePort {
  private readonly logger = createLogger('cache');
  private readonly inflight = new Map<string, Promise<unknown>>();

  constructor(private readonly store: CacheStore) {}

  async get<T>(key: CacheKey): Promise<T | undefined> {
    return decodeCacheValue<T>(await this.store.getRaw(key));
  }

  async set<T>(key: CacheKey, value: T, ttlSeconds: number): Promise<void> {
    assertPositiveInteger(ttlSeconds, 'Cache ttlSeconds');
    await this.store.setRaw(key, encodeCacheValue(value), ttlSeconds);
  }

  async del(key: CacheKey): Promise<void> {
    await this.store.del(key);
  }

  getOrLoad<T>(
    key: CacheKey,
    ttlSeconds: number,
    loader: () => Promise<T>,
  ): Promise<T> {
    try {
      assertPositiveInteger(ttlSeconds, 'Cache ttlSeconds');
    } catch (err) {
      return Promise.reject(err as Error);
    }
    const pending = this.inflight.get(key);
    if (pending) return pending as Promise<T>;

    const flight = this.load(key, ttlSeconds, loader).finally(() => {
      this.inflight.delete(key);
    });
    this.inflight.set(key, flight);
    return flight;
  }

  health(): Promise<CapabilityHealth> {
    return this.store.health();
  }

  private async load<T>(
    key: CacheKey,
    ttlSeconds: number,
    loader: () => Promise<T>,
  ): Promise<T> {
    try {
      const cached = await this.get<T>(key);
      if (cached !== undefined) return cached;
    } catch (err) {
      if (err instanceof CapabilityDisabledError) throw err;
      this.logger.warn(
        'read-failed',
        'Cache read failed, loading directly',
        {},
        err,
      );
    }

    const value = await loader();
    if (value !== undefined) {
      await this.set(key, value, ttlSeconds).catch((err: unknown) => {
        this.logger.warn('write-failed', 'Cache write failed', {}, err);
      });
    }
    return value;
  }
}
