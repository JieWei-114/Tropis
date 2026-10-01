import { capabilityDisabled, type CapabilityHealth } from '../../../capability';
import type { CacheKey } from '../../../../common/keyspace';
import type { CachePort } from '../../cache.port';

/**
 * Cached data is optional by definition, so a disabled cache is a pass-through:
 * every read misses, writes are dropped and getOrLoad always runs the loader.
 */
export class DisabledCacheAdapter implements CachePort {
  get<T>(): Promise<T | undefined> {
    return Promise.resolve(undefined);
  }

  set(): Promise<void> {
    return Promise.resolve();
  }

  del(): Promise<void> {
    return Promise.resolve();
  }

  getOrLoad<T>(
    _key: CacheKey,
    _ttlSeconds: number,
    loader: () => Promise<T>,
  ): Promise<T> {
    return loader();
  }

  health(): Promise<CapabilityHealth> {
    return Promise.resolve(capabilityDisabled());
  }
}
