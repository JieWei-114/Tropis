import type Redis from 'ioredis';
import { defineKey } from '../../../common/keyspace';
import { RedisDedupAdapter } from '../adapters/redis/redis-dedup.adapter';

const KEY = defineKey({
  capability: 'dedup',
  module: 'test',
  name: 'event',
  version: 'v1',
});

interface PipelineStub {
  set: jest.Mock;
  eval: jest.Mock;
  exec: jest.Mock;
}

function redisWith(replies: [Error | null, unknown][] | Error) {
  const del = jest.fn(() => Promise.resolve(1));
  const evals: unknown[][] = [];
  const pipeline: PipelineStub = {
    set: jest.fn().mockReturnThis(),
    eval: jest.fn((...args: unknown[]) => {
      evals.push(args);
      return pipeline;
    }),
    exec: jest.fn(() =>
      replies instanceof Error
        ? Promise.reject(replies)
        : Promise.resolve(replies),
    ),
  };
  const redis = { pipeline: () => pipeline, del } as unknown as Redis;
  return { adapter: new RedisDedupAdapter(redis), del, pipeline, evals };
}

describe('RedisDedupAdapter.claimMany', () => {
  const keys = ['a', 'b', 'c'].map((id) => KEY.global(id));

  it('drops the claims it won when another claim of the call fails', async () => {
    const boom = new Error('OOM');
    const { adapter, del } = redisWith([
      [null, 'OK'],
      [boom, null],
      [null, 'OK'],
    ]);
    await expect(adapter.claimMany(keys, 30, 'owner')).rejects.toBe(boom);
    expect(del).toHaveBeenCalledWith(keys[0], keys[2]);
  });

  it('releases its own claims best-effort when the round trip fails', async () => {
    const lost = new Error('connection lost');
    const { adapter, evals } = redisWith(lost);
    await expect(adapter.claimMany(keys, 30, 'owner')).rejects.toBe(lost);
    expect(evals.map((e) => e[2])).toEqual(keys);
    expect(evals.every((e) => e[3] === 'owner')).toBe(true);
  });
});
