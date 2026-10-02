import { defineKey } from '../../../common/keyspace';
import { CapabilityDisabledError } from '../../capability';
import type { DedupPort } from '../../dedup/dedup.port';
import {
  EventConsumer,
  RESUBSCRIBE_BASE_MS,
  type ConsumerSpec,
} from '../event-consumer';
import type { MessageSubscription, MessagingPort } from '../messaging.port';
import { inMemoryDedup } from './consumer-harness';

const KEY = defineKey({
  capability: 'dedup',
  module: 'test',
  name: 'event',
  version: 'v1',
});

const spec: ConsumerSpec<object> = {
  topic: 'user-events',
  subscription: 'user-sub',
  module: 'test',
  handle: () => Promise.resolve(),
};

function subscription() {
  let stop: (err: unknown) => void = () => undefined;
  const close = jest.fn(() => Promise.resolve());
  const sub: MessageSubscription = {
    close,
    stopped: new Promise((resolve) => (stop = resolve)),
  };
  return { sub, close, stop: (err: unknown) => stop(err) };
}

function consumerWith(subscribe: jest.Mock) {
  return new EventConsumer(
    { subscribe } as unknown as MessagingPort,
    inMemoryDedup() as unknown as DedupPort,
  );
}

describe('EventConsumer.start', () => {
  afterEach(() => jest.useRealTimers());

  it('retries a failed subscribe with backoff and reports down until it succeeds', async () => {
    jest.useFakeTimers();
    const { sub } = subscription();
    const subscribe = jest
      .fn()
      .mockRejectedValueOnce(new Error('broker down'))
      .mockRejectedValueOnce(new Error('broker down'))
      .mockResolvedValue(sub);
    const consumer = consumerWith(subscribe);

    consumer.start(spec);
    await jest.advanceTimersByTimeAsync(0);
    expect((await consumer.health()).status).toBe('down');
    expect(consumer.status()[0]).toMatchObject({
      state: 'retrying',
      failures: 1,
    });

    await jest.advanceTimersByTimeAsync(RESUBSCRIBE_BASE_MS);
    expect(subscribe).toHaveBeenCalledTimes(2);
    await jest.advanceTimersByTimeAsync(RESUBSCRIBE_BASE_MS);
    expect(subscribe).toHaveBeenCalledTimes(2);
    await jest.advanceTimersByTimeAsync(RESUBSCRIBE_BASE_MS);
    expect(subscribe).toHaveBeenCalledTimes(3);
    expect((await consumer.health()).status).toBe('up');
    await consumer.onModuleDestroy();
  });

  it('resubscribes when a running subscription stops on its own', async () => {
    jest.useFakeTimers();
    const first = subscription();
    const second = subscription();
    const subscribe = jest
      .fn()
      .mockResolvedValueOnce(first.sub)
      .mockResolvedValueOnce(second.sub);
    const consumer = consumerWith(subscribe);

    consumer.start(spec);
    await jest.advanceTimersByTimeAsync(0);
    expect(consumer.status()[0].state).toBe('running');

    first.stop(new Error('receive failed'));
    await jest.advanceTimersByTimeAsync(0);
    expect((await consumer.health()).status).toBe('down');
    await jest.advanceTimersByTimeAsync(RESUBSCRIBE_BASE_MS);
    expect(subscribe).toHaveBeenCalledTimes(2);
    expect(consumer.status()[0].state).toBe('running');
    await consumer.onModuleDestroy();
    expect(second.close).toHaveBeenCalled();
  });

  it('stops retrying once closed', async () => {
    jest.useFakeTimers();
    const subscribe = jest.fn().mockRejectedValue(new Error('down'));
    const consumer = consumerWith(subscribe);
    const handle = consumer.start(spec);
    await jest.advanceTimersByTimeAsync(0);
    await handle.close();
    await jest.advanceTimersByTimeAsync(RESUBSCRIBE_BASE_MS * 100);
    expect(subscribe).toHaveBeenCalledTimes(1);
    expect(consumer.status()).toEqual([]);
  });

  it('treats disabled messaging as nothing to run', async () => {
    const subscribe = jest
      .fn()
      .mockRejectedValue(new CapabilityDisabledError('messaging', 'subscribe'));
    const consumer = consumerWith(subscribe);
    consumer.start(spec);
    await Promise.resolve();
    await Promise.resolve();
    expect(consumer.status()[0].state).toBe('disabled');
    expect((await consumer.health()).status).toBe('up');
  });
});

describe('EventConsumer.onceEach', () => {
  it('runs nothing and rethrows when the claims cannot be taken', async () => {
    const dedup = inMemoryDedup();
    dedup.claimMany.mockRejectedValueOnce(new Error('redis down'));
    const consumer = new EventConsumer(
      {} as MessagingPort,
      dedup as unknown as DedupPort,
    );
    const work = jest.fn(() => Promise.resolve());
    await expect(
      consumer.onceEach(['a', 'b'], (id) => KEY.global(id), work),
    ).rejects.toThrow('redis down');
    expect(work).not.toHaveBeenCalled();
  });

  it('releases only the claims of its own attempt', async () => {
    const dedup = inMemoryDedup();
    const consumer = new EventConsumer(
      {} as MessagingPort,
      dedup as unknown as DedupPort,
    );
    await expect(
      consumer.onceEach(
        ['a'],
        (id) => KEY.global(id),
        () => {
          // The claim expired mid-work and another attempt took it.
          dedup.keys.set(KEY.global('a'), 'other-attempt');
          return Promise.reject(new Error('sink down'));
        },
      ),
    ).rejects.toThrow('sink down');
    expect(dedup.keys.get(KEY.global('a'))).toBe('other-attempt');
  });

  it('claims, commits and releases all keys of a batch in one call each', async () => {
    const dedup = inMemoryDedup();
    const consumer = new EventConsumer(
      {} as MessagingPort,
      dedup as unknown as DedupPort,
    );
    await consumer.onceEach(
      ['a', 'b', 'c'],
      (id) => KEY.global(id),
      () => Promise.resolve(),
    );
    expect(dedup.claimMany).toHaveBeenCalledTimes(1);
    expect(dedup.extendMany).toHaveBeenCalledTimes(1);
    expect(dedup.claim).not.toHaveBeenCalled();
  });

  it('keeps work done when the seen markers cannot be committed', async () => {
    const dedup = inMemoryDedup();
    dedup.extendMany.mockRejectedValueOnce(new Error('redis down'));
    const consumer = new EventConsumer(
      {} as MessagingPort,
      dedup as unknown as DedupPort,
    );
    const work = jest.fn(() => Promise.resolve());
    await expect(
      consumer.onceEach(['a'], (id) => KEY.global(id), work),
    ).resolves.toEqual(['a']);
    expect(dedup.releaseMany).not.toHaveBeenCalled();
  });
});
