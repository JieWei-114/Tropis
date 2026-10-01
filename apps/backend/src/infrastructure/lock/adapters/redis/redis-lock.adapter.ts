import { randomUUID } from 'crypto';
import type Redis from 'ioredis';
import type { LockKey } from '../../../../common/keyspace';
import {
  assertPositiveInteger,
  probeCapability,
  type CapabilityHealth,
} from '../../../capability';
import type { Lease, LockPort } from '../../lock.port';

/** Compare-and-set: act on the key only while it still holds our token. */
const RENEW_IF_OWNER = `if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("pexpire", KEYS[1], ARGV[2]) else return 0 end`;
const RELEASE_IF_OWNER = `if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end`;

export class RedisLockAdapter implements LockPort {
  constructor(private readonly redis: Redis) {}

  async acquire(key: LockKey, ttlMs: number): Promise<Lease | null> {
    assertPositiveInteger(ttlMs, 'Lock ttlMs');
    const token = randomUUID();
    const acquired = await this.redis.set(key, token, 'PX', ttlMs, 'NX');
    if (acquired !== 'OK') return null;

    const redis = this.redis;
    return {
      key,
      token,
      async renew(nextTtlMs: number): Promise<boolean> {
        assertPositiveInteger(nextTtlMs, 'Lock ttlMs');
        const renewed = await redis.eval(
          RENEW_IF_OWNER,
          1,
          key,
          token,
          String(nextTtlMs),
        );
        return renewed === 1;
      },
      async release(): Promise<boolean> {
        return (await redis.eval(RELEASE_IF_OWNER, 1, key, token)) === 1;
      },
    };
  }

  health(): Promise<CapabilityHealth> {
    return probeCapability('redis', () => this.redis.ping());
  }
}
