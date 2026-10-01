import type { DedupKey } from '../../../common/keyspace';
import {
  assertPositiveInteger,
  capabilityUp,
  type CapabilityHealth,
} from '../../capability';
import { InMemoryTtlMap } from '../../capability/__tests__/in-memory-ttl-map';
import { ANONYMOUS_OWNER, type DedupPort } from '../dedup.port';

export class InMemoryDedupAdapter implements DedupPort {
  private readonly markers = new InMemoryTtlMap<string>();

  claim(key: DedupKey, ttlSeconds: number, owner?: string): Promise<boolean> {
    return this.claimMany([key], ttlSeconds, owner).then((r) => r[0]);
  }

  claimMany(
    keys: readonly DedupKey[],
    ttlSeconds: number,
    owner = ANONYMOUS_OWNER,
  ): Promise<boolean[]> {
    return this.guard(ttlSeconds, () =>
      keys.map((key) => {
        if (this.markers.has(key)) return false;
        this.markers.set(key, owner, ttlSeconds * 1000);
        return true;
      }),
    );
  }

  extend(key: DedupKey, ttlSeconds: number, owner?: string): Promise<boolean> {
    return this.extendMany([key], ttlSeconds, owner).then((r) => r[0]);
  }

  extendMany(
    keys: readonly DedupKey[],
    ttlSeconds: number,
    owner?: string,
  ): Promise<boolean[]> {
    return this.guard(ttlSeconds, () =>
      keys.map((key) => {
        if (owner !== undefined && this.markers.get(key) !== owner) {
          return false;
        }
        return this.markers.expire(key, ttlSeconds * 1000);
      }),
    );
  }

  release(key: DedupKey, owner?: string): Promise<boolean> {
    return this.releaseMany([key], owner).then((r) => r[0]);
  }

  releaseMany(keys: readonly DedupKey[], owner?: string): Promise<boolean[]> {
    return Promise.resolve(
      keys.map((key) => {
        if (owner !== undefined && this.markers.get(key) !== owner) {
          return false;
        }
        return this.markers.delete(key);
      }),
    );
  }

  health(): Promise<CapabilityHealth> {
    return Promise.resolve(capabilityUp('memory'));
  }

  private guard<T>(ttlSeconds: number, fn: () => T): Promise<T> {
    try {
      assertPositiveInteger(ttlSeconds, 'Dedup ttlSeconds');
      return Promise.resolve(fn());
    } catch (err) {
      return Promise.reject(err as Error);
    }
  }
}
