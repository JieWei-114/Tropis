import type Redis from 'ioredis';
import type { DedupKey } from '../../../../common/keyspace';
import {
  assertPositiveInteger,
  probeCapability,
  type CapabilityHealth,
} from '../../../capability';
import { ANONYMOUS_OWNER, type DedupPort } from '../../dedup.port';

const EXTEND_IF_OWNER = `if redis.call('get', KEYS[1]) == ARGV[1] then
  return redis.call('expire', KEYS[1], ARGV[2])
end
return 0`;

const RELEASE_IF_OWNER = `if redis.call('get', KEYS[1]) == ARGV[1] then
  return redis.call('del', KEYS[1])
end
return 0`;

type Replies = [Error | null, unknown][] | null;

function answers(replies: Replies, ok: (reply: unknown) => boolean): boolean[] {
  return (replies ?? []).map(([err, reply]) => {
    if (err) throw err;
    return ok(reply);
  });
}

/**
 * DedupPort over Redis: SET NX EX markers, owner-checked extend and release
 * by Lua compare-and-act, every *Many call one pipeline. claimMany is all or
 * nothing: when any claim errors, the claims it won are dropped and the
 * error thrown.
 */
export class RedisDedupAdapter implements DedupPort {
  constructor(private readonly redis: Redis) {}

  async claim(
    key: DedupKey,
    ttlSeconds: number,
    owner?: string,
  ): Promise<boolean> {
    return (await this.claimMany([key], ttlSeconds, owner))[0];
  }

  async claimMany(
    keys: readonly DedupKey[],
    ttlSeconds: number,
    owner = ANONYMOUS_OWNER,
  ): Promise<boolean[]> {
    assertPositiveInteger(ttlSeconds, 'Dedup ttlSeconds');
    if (!keys.length) return [];
    const pipeline = this.redis.pipeline();
    for (const key of keys) pipeline.set(key, owner, 'EX', ttlSeconds, 'NX');
    let replies: Replies;
    try {
      replies = await pipeline.exec();
    } catch (err) {
      if (owner !== ANONYMOUS_OWNER) {
        await this.releaseMany(keys, owner).catch(() => undefined);
      }
      throw err;
    }
    const failure = (replies ?? []).find(([err]) => err)?.[0];
    if (failure) {
      // All or nothing: the claims this call did win are dropped again, so
      // a caller that sees the error leaves no key claimed behind it.
      const won = keys.filter((_, i) => replies?.[i]?.[1] === 'OK');
      if (won.length) await this.redis.del(...won).catch(() => undefined);
      throw failure;
    }
    return answers(replies, (r) => r === 'OK');
  }

  async extend(
    key: DedupKey,
    ttlSeconds: number,
    owner?: string,
  ): Promise<boolean> {
    return (await this.extendMany([key], ttlSeconds, owner))[0];
  }

  async extendMany(
    keys: readonly DedupKey[],
    ttlSeconds: number,
    owner?: string,
  ): Promise<boolean[]> {
    assertPositiveInteger(ttlSeconds, 'Dedup ttlSeconds');
    if (!keys.length) return [];
    const pipeline = this.redis.pipeline();
    for (const key of keys) {
      if (owner === undefined) pipeline.expire(key, ttlSeconds);
      else pipeline.eval(EXTEND_IF_OWNER, 1, key, owner, ttlSeconds);
    }
    return answers(await pipeline.exec(), (r) => r === 1);
  }

  async release(key: DedupKey, owner?: string): Promise<boolean> {
    return (await this.releaseMany([key], owner))[0];
  }

  async releaseMany(
    keys: readonly DedupKey[],
    owner?: string,
  ): Promise<boolean[]> {
    if (!keys.length) return [];
    const pipeline = this.redis.pipeline();
    for (const key of keys) {
      if (owner === undefined) pipeline.del(key);
      else pipeline.eval(RELEASE_IF_OWNER, 1, key, owner);
    }
    return answers(await pipeline.exec(), (r) => r === 1);
  }

  health(): Promise<CapabilityHealth> {
    return probeCapability('redis', () => this.redis.ping());
  }
}
