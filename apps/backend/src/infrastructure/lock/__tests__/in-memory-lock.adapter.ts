import { randomUUID } from 'crypto';
import type { LockKey } from '../../../common/keyspace';
import {
  assertPositiveInteger,
  capabilityUp,
  type CapabilityHealth,
} from '../../capability';
import { InMemoryTtlMap } from '../../capability/__tests__/in-memory-ttl-map';
import type { Lease, LockPort } from '../lock.port';

export class InMemoryLockAdapter implements LockPort {
  private readonly owners = new InMemoryTtlMap<string>();

  acquire(key: LockKey, ttlMs: number): Promise<Lease | null> {
    try {
      assertPositiveInteger(ttlMs, 'Lock ttlMs');
    } catch (err) {
      return Promise.reject(err as Error);
    }
    if (this.owners.has(key)) return Promise.resolve(null);
    const token = randomUUID();
    this.owners.set(key, token, ttlMs);
    const owners = this.owners;
    return Promise.resolve({
      key,
      token,
      renew(next: number) {
        try {
          assertPositiveInteger(next, 'Lock ttlMs');
        } catch (err) {
          return Promise.reject(err as Error);
        }
        if (owners.get(key) !== token) return Promise.resolve(false);
        owners.set(key, token, next);
        return Promise.resolve(true);
      },
      release() {
        if (owners.get(key) !== token) return Promise.resolve(false);
        owners.delete(key);
        return Promise.resolve(true);
      },
    });
  }

  health(): Promise<CapabilityHealth> {
    return Promise.resolve(capabilityUp('memory'));
  }
}
