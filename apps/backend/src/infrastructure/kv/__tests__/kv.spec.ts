import { defineKey, type CacheKey } from '../../../common/keyspace';
import { CapabilityDisabledError } from '../../capability';
import { DisabledKvAdapter } from '../adapters/disabled/disabled-kv.adapter';
import { decodeKvValue, KvDecodeError, resolveKvLifetime } from '../kv.codec';
import type { KvPort } from '../kv.port';
import { InMemoryKvAdapter } from './in-memory-kv.adapter';
import { describeKvPort } from './kv.conformance';

describeKvPort('in-memory fake', { make: () => new InMemoryKvAdapter() });

const KEY = defineKey({
  capability: 'kv',
  module: 'test',
  name: 'item',
  version: 'v1',
}).global('1');

describe('kv codec', () => {
  it('throws on corrupt values instead of reporting a miss', () => {
    expect(() => decodeKvValue(KEY, 'nope')).toThrow(KvDecodeError);
    expect(() => decodeKvValue(KEY, '{"v":2,"d":1}')).toThrow(KvDecodeError);
    expect(decodeKvValue(KEY, null)).toBeUndefined();
  });

  it('resolves lifetimes', () => {
    expect(resolveKvLifetime({ ttlSeconds: 5 })).toBe(5);
    expect(resolveKvLifetime({ persistent: true })).toBeNull();
  });
});

describe('DisabledKvAdapter', () => {
  const kv: KvPort = new DisabledKvAdapter();

  it('throws CapabilityDisabledError from every method', async () => {
    for (const call of [
      () => kv.get(KEY),
      () => kv.set(KEY, 1, { ttlSeconds: 1 }),
      () => kv.del(KEY),
      () => kv.exists(KEY),
    ]) {
      await expect(call()).rejects.toBeInstanceOf(CapabilityDisabledError);
    }
    expect((await kv.health()).status).toBe('disabled');
  });

  it('enforces key and lifetime types', () => {
    const cacheKey = defineKey({
      capability: 'cache',
      module: 'test',
      name: 'item',
      version: 'v1',
    }).global() as CacheKey;
    // @ts-expect-error a CacheKey cannot address kv
    void kv.exists(cacheKey).catch(() => undefined);
    // @ts-expect-error a write must state ttlSeconds or persistent
    void kv.set(KEY, 1, {}).catch(() => undefined);
    const both = { persistent: true, ttlSeconds: 1 } as const;
    // @ts-expect-error persistent and ttlSeconds are mutually exclusive
    void kv.set(KEY, 1, both).catch(() => undefined);
  });
});
