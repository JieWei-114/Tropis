import type { CacheKey } from '../../common/keyspace';
import type { HealthCheckable } from '../capability';

/**
 * Cache — derived data with a TTL that is safe to lose. Every write carries a
 * TTL (there is no TTL-less write), values are serialized by the port as
 * versioned JSON, and a read that fails to decode is a miss, never an error.
 * Use the kv capability for state that must survive until its TTL.
 */
export const CACHE = Symbol('CACHE');

export interface CachePort extends HealthCheckable {
  /** The cached value, or `undefined` on a miss. */
  get<T>(key: CacheKey): Promise<T | undefined>;
  /** Stores a JSON-serializable value (not `undefined`) for `ttlSeconds`. */
  set<T>(key: CacheKey, value: T, ttlSeconds: number): Promise<void>;
  del(key: CacheKey): Promise<void>;
  /**
   * Returns the cached value or runs `loader`, caching its result for
   * `ttlSeconds`. Concurrent misses for one key in this process share a
   * single loader call (single-flight). A loader rejection reaches every
   * waiter and is not cached. A failing store read or write degrades to
   * calling the loader, because cached data is by definition optional.
   */
  getOrLoad<T>(
    key: CacheKey,
    ttlSeconds: number,
    loader: () => Promise<T>,
  ): Promise<T>;
}

/**
 * Adapter-facing contract: raw strings with a TTL. Serialization and
 * single-flight live once in CacheClient, so adapters stay trivial and
 * cannot diverge on those rules.
 */
export interface CacheStore extends HealthCheckable {
  getRaw(key: string): Promise<string | null>;
  setRaw(key: string, value: string, ttlSeconds: number): Promise<void>;
  del(key: string): Promise<void>;
}

export const CACHE_ADAPTERS = ['redis', 'disabled'] as const;
export type CacheAdapterName = (typeof CACHE_ADAPTERS)[number];
