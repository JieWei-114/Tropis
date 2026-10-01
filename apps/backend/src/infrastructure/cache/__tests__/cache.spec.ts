import { defineKey, toTenantId, type KvKey } from '../../../common/keyspace';
import { DisabledCacheAdapter } from '../adapters/disabled/disabled-cache.adapter';
import { CacheClient } from '../cache.client';
import {
  CACHE_CODEC_VERSION,
  decodeCacheValue,
  encodeCacheValue,
} from '../cache.codec';
import type { CachePort, CacheStore } from '../cache.port';
import { describeCachePort } from './cache.conformance';
import { InMemoryCacheStore } from './in-memory-cache.store';

describeCachePort('in-memory fake', {
  make: () => new CacheClient(new InMemoryCacheStore()),
});

const KEY = defineKey({
  capability: 'cache',
  module: 'test',
  name: 'item',
  version: 'v1',
}).forTenant(toTenantId('acme'), '1');

describe('cache codec', () => {
  it('wraps values in a versioned envelope', () => {
    expect(JSON.parse(encodeCacheValue({ a: 1 }))).toEqual({
      v: CACHE_CODEC_VERSION,
      d: { a: 1 },
    });
    expect(() => encodeCacheValue(undefined)).toThrow(TypeError);
  });

  it('treats corrupt or foreign-version values as a miss', () => {
    expect(decodeCacheValue('not json')).toBeUndefined();
    expect(decodeCacheValue('{"v":99,"d":1}')).toBeUndefined();
    expect(decodeCacheValue('"bare"')).toBeUndefined();
    expect(decodeCacheValue(null)).toBeUndefined();
    expect(decodeCacheValue('{"v":1,"d":0}')).toBe(0);
  });
});

describe('CacheClient degradation', () => {
  const broken: CacheStore = {
    getRaw: () => Promise.reject(new Error('down')),
    setRaw: () => Promise.reject(new Error('down')),
    del: () => Promise.reject(new Error('down')),
    health: () => Promise.resolve({ status: 'down', adapter: 'broken' }),
  };

  it('falls back to the loader when the store fails', async () => {
    const cache = new CacheClient(broken);
    await expect(
      cache.getOrLoad(KEY, 10, () => Promise.resolve(42)),
    ).resolves.toBe(42);
    await expect(cache.get(KEY)).rejects.toThrow('down');
  });
});

describe('DisabledCacheAdapter', () => {
  const cache: CachePort = new DisabledCacheAdapter();

  it('passes through: every read misses and getOrLoad runs the loader', async () => {
    const loader = jest.fn().mockResolvedValue({ id: 1 });
    await expect(cache.getOrLoad(KEY, 10, loader)).resolves.toEqual({ id: 1 });
    await expect(cache.getOrLoad(KEY, 10, loader)).resolves.toEqual({ id: 1 });
    expect(loader).toHaveBeenCalledTimes(2);
    await expect(cache.set(KEY, 1, 10)).resolves.toBeUndefined();
    await expect(cache.get(KEY)).resolves.toBeUndefined();
    await expect(cache.del(KEY)).resolves.toBeUndefined();
    expect((await cache.health()).status).toBe('disabled');
  });

  it('propagates a loader failure', async () => {
    await expect(
      cache.getOrLoad(KEY, 10, () => Promise.reject(new Error('db down'))),
    ).rejects.toThrow('db down');
  });

  it('accepts only cache keys', () => {
    const kvKey = defineKey({
      capability: 'kv',
      module: 'test',
      name: 'item',
      version: 'v1',
    }).global() as KvKey;
    // @ts-expect-error a KvKey cannot address the cache
    void cache.get(kvKey).catch(() => undefined);
    const raw = 'tropis:test:global:cache:test:item:v1';
    // @ts-expect-error a raw string cannot address the cache
    void cache.del(raw).catch(() => undefined);
  });
});
