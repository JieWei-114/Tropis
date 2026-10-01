import { Types } from 'mongoose';
import { CapabilityDisabledError } from '../../capability';
import type { Gauge } from 'prom-client';
import { InMemoryLockAdapter } from '../../lock/__tests__/in-memory-lock.adapter';
import type { LockPort } from '../../lock/lock.port';
import type {
  MessagingPort,
  PublishOptions,
} from '../../messaging/messaging.port';
import {
  AGGREGATE_LEASE_TTL_MS,
  AGGREGATES_PER_POLL,
  CANDIDATES_PER_POLL,
  LEASE_RENEW_INTERVAL_MS,
  OUTBOX_AGGREGATE_LEASE,
  OUTBOX_EVENT_SOURCE,
  OUTBOX_POLL_INTERVAL_MS,
  OUTBOX_PUBLISH_TIMEOUT_MS,
} from '../outbox.constants';
import { OutboxRelay } from '../outbox.relay';
import { OPEN_STATUSES, OutboxStatus } from '../outbox.schema';
import type { OutboxService } from '../outbox.service';

interface Row {
  _id: Types.ObjectId;
  aggregateId: string;
  topic: string;
  payload: Record<string, unknown>;
  status: OutboxStatus;
  attempts: number;
  nextAttemptAt: Date | null;
  createdAt: Date;
  event?: Record<string, unknown>;
}

/** The OutboxService contract the relay relies on, over an array. */
class FakeOutbox {
  rows: Row[] = [];
  private seq = 0;

  add(aggregateId: string, extra: Partial<Row> = {}): Row {
    this.seq += 1;
    const row: Row = {
      _id: new Types.ObjectId(),
      aggregateId,
      topic: 'user-events',
      payload: { n: this.seq },
      status: OutboxStatus.PENDING,
      attempts: 0,
      nextAttemptAt: null,
      createdAt: new Date(1_000 + this.seq),
      event: {
        id: `evt-${this.seq}`,
        type: 'user.created',
        tenantId: 'acme',
        time: new Date(Date.UTC(2026, 8, 30)),
        schemaVersion: '1',
      },
      ...extra,
    };
    this.rows.push(row);
    return row;
  }

  private head(aggregateId: string): Row | undefined {
    return this.rows
      .filter(
        (r) =>
          r.aggregateId === aggregateId && OPEN_STATUSES.includes(r.status),
      )
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())[0];
  }

  dueAggregates = jest.fn((limit: number) => {
    const now = Date.now();
    const ids = [...new Set(this.rows.map((r) => r.aggregateId))];
    return Promise.resolve(
      ids
        .filter((id) => {
          const h = this.head(id);
          if (!h) return false;
          if (h.status === OutboxStatus.PENDING) return true;
          return (
            h.status === OutboxStatus.FAILED &&
            (!h.nextAttemptAt || h.nextAttemptAt.getTime() <= now)
          );
        })
        .slice(0, limit),
    );
  });

  headOf = jest.fn((id: string) => Promise.resolve(this.head(id) ?? null));

  markDispatched = jest.fn((id: string) => {
    const row = this.rows.find((r) => r._id.toString() === id)!;
    row.status = OutboxStatus.DISPATCHED;
    return Promise.resolve();
  });

  markFailed = jest.fn((ref: Row, _err: string, max: number) => {
    const row = this.rows.find((r) => r._id.equals(ref._id))!;
    row.attempts += 1;
    row.status = row.attempts >= max ? OutboxStatus.DEAD : OutboxStatus.FAILED;
    row.nextAttemptAt =
      row.status === OutboxStatus.FAILED ? new Date(Date.now() + 60_000) : null;
    return Promise.resolve(row.status);
  });

  settleHead = jest.fn().mockResolvedValue(undefined);
  repairHeads = jest.fn().mockResolvedValue(0);
  deadLetterExhausted = jest.fn().mockResolvedValue(0);
  countDead = jest.fn().mockResolvedValue(0);
  backlogByStatus = jest.fn().mockResolvedValue({ pending: 0 });
}

describe('OutboxRelay', () => {
  let outbox: FakeOutbox;
  let published: Array<{ payload: unknown; opts?: PublishOptions }>;
  let broker: { publish: jest.Mock };
  let gauge: { set: jest.Mock };

  const relayWith = (lock: LockPort) =>
    new OutboxRelay(
      outbox as unknown as OutboxService,
      broker as unknown as MessagingPort,
      lock,
      gauge as unknown as Gauge<'status'>,
      gauge as unknown as Gauge<string>,
    );

  beforeEach(() => {
    outbox = new FakeOutbox();
    published = [];
    broker = {
      publish: jest.fn(
        (_t: string, payload: unknown, opts?: PublishOptions) => {
          published.push({ payload, opts });
          return Promise.resolve();
        },
      ),
    };
    gauge = { set: jest.fn() };
  });

  it('publishes the payload as the body with the row event attributes', async () => {
    const row = outbox.add('user-1');

    await relayWith(new InMemoryLockAdapter()).relay();

    expect(broker.publish).toHaveBeenCalledWith(row.topic, row.payload, {
      event: {
        id: 'evt-1',
        type: 'user.created',
        subject: 'user-1',
        tenantId: 'acme',
        schemaVersion: '1',
        time: '2026-09-30T00:00:00.000Z',
        source: OUTBOX_EVENT_SOURCE,
      },
      key: 'user-1',
    });
    expect(row.status).toBe(OutboxStatus.DISPATCHED);
  });

  it('publishes each aggregate in order under that aggregate lease', async () => {
    outbox.add('a');
    outbox.add('b');
    outbox.add('a');
    const lock = new InMemoryLockAdapter();
    const acquire = jest.spyOn(lock, 'acquire');

    await relayWith(lock).relay();

    expect(published.map((p) => p.payload)).toEqual([
      { n: 1 },
      { n: 3 },
      { n: 2 },
    ]);
    expect(acquire).toHaveBeenCalledWith(
      OUTBOX_AGGREGATE_LEASE.global('a'),
      AGGREGATE_LEASE_TTL_MS,
    );
    await expect(
      lock.acquire(OUTBOX_AGGREGATE_LEASE.global('a'), 1000),
    ).resolves.not.toBeNull();
  });

  it('skips an aggregate another instance holds and relays the rest', async () => {
    outbox.add('a');
    outbox.add('b');
    const lock = new InMemoryLockAdapter();
    await lock.acquire(OUTBOX_AGGREGATE_LEASE.global('a'), 60_000);

    await relayWith(lock).relay();

    expect(published.map((p) => p.payload)).toEqual([{ n: 2 }]);
    expect(outbox.rows[0].status).toBe(OutboxStatus.PENDING);
  });

  it('stops an aggregate at a failed publish so its later rows wait', async () => {
    outbox.add('a');
    outbox.add('a');
    outbox.add('b');
    broker.publish.mockRejectedValueOnce(new Error('broker down'));

    await relayWith(new InMemoryLockAdapter()).relay();

    expect(outbox.rows.map((r) => r.status)).toEqual([
      OutboxStatus.FAILED,
      OutboxStatus.PENDING,
      OutboxStatus.DISPATCHED,
    ]);

    await relayWith(new InMemoryLockAdapter()).relay();
    expect(outbox.rows[1].status).toBe(OutboxStatus.PENDING);
  });

  it('retries a FAILED row once due, including one without nextAttemptAt', async () => {
    outbox.add('a', { status: OutboxStatus.FAILED, attempts: 1 });
    outbox.add('a');

    await relayWith(new InMemoryLockAdapter()).relay();

    expect(outbox.rows.map((r) => r.status)).toEqual([
      OutboxStatus.DISPATCHED,
      OutboxStatus.DISPATCHED,
    ]);
  });

  it('leaves an aggregate behind a DEAD row until it is redriven or skipped', async () => {
    outbox.add('a', { status: OutboxStatus.DEAD, attempts: 5 });
    outbox.add('a');

    await relayWith(new InMemoryLockAdapter()).relay();
    expect(broker.publish).not.toHaveBeenCalled();

    outbox.rows[0].status = OutboxStatus.SKIPPED;
    await relayWith(new InMemoryLockAdapter()).relay();
    expect(published.map((p) => p.payload)).toEqual([{ n: 2 }]);
  });

  it('moves a row to DEAD on its last attempt', async () => {
    outbox.add('a', { status: OutboxStatus.FAILED, attempts: 4 });
    broker.publish.mockRejectedValueOnce(new Error('still down'));

    await relayWith(new InMemoryLockAdapter()).relay();

    expect(outbox.rows[0].status).toBe(OutboxStatus.DEAD);
  });

  it('stops the aggregate once its lease is lost', async () => {
    outbox.add('a');
    outbox.add('a');
    const release = jest.fn().mockResolvedValue(false);
    const renew = jest
      .fn()
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);
    const lock: LockPort = {
      acquire: jest.fn().mockResolvedValue({
        key: OUTBOX_AGGREGATE_LEASE.global('a'),
        token: 't',
        renew,
        release,
      }),
      health: jest.fn(),
    };

    await relayWith(lock).relay();

    expect(broker.publish).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalled();
  });

  it('stops the poll when the lease store is down', async () => {
    outbox.add('a');
    const lock: LockPort = {
      acquire: jest.fn().mockRejectedValue(new Error('down')),
      health: jest.fn(),
    };
    await expect(relayWith(lock).relay()).resolves.toEqual({ full: false });
    expect(broker.publish).not.toHaveBeenCalled();
  });

  it('does not overlap polls in one instance', async () => {
    outbox.add('a');
    let finish!: () => void;
    broker.publish.mockImplementationOnce(
      () => new Promise<void>((r) => (finish = r)),
    );
    const relay = relayWith(new InMemoryLockAdapter());

    const first = relay.relay();
    await new Promise((r) => setImmediate(r));
    await relay.relay();
    expect(outbox.dueAggregates).toHaveBeenCalledTimes(1);
    finish();
    await first;
  });

  it('drains the in-flight poll on shutdown and polls no more', async () => {
    outbox.add('a');
    outbox.add('b');
    let finish!: () => void;
    broker.publish.mockImplementationOnce(
      () => new Promise<void>((r) => (finish = r)),
    );
    const relay = relayWith(new InMemoryLockAdapter());

    const poll = relay.relay();
    await new Promise((r) => setImmediate(r));
    let drained = false;
    const shutdown = relay.onModuleDestroy().then(() => (drained = true));
    await new Promise((r) => setImmediate(r));
    expect(drained).toBe(false);

    finish();
    await Promise.all([poll, shutdown]);
    expect(broker.publish).toHaveBeenCalledTimes(1);

    await relay.relay();
    await relay.sweep();
    expect(outbox.dueAggregates).toHaveBeenCalledTimes(1);
    expect(outbox.deadLetterExhausted).not.toHaveBeenCalled();
  });

  it('keeps the lease above the publish timeout', () => {
    expect(AGGREGATE_LEASE_TTL_MS).toBeGreaterThan(OUTBOX_PUBLISH_TIMEOUT_MS);
  });

  it('renews the lease while a publish is in flight', async () => {
    jest.useFakeTimers();
    try {
      outbox.add('a');
      let finish!: () => void;
      broker.publish.mockImplementationOnce(
        () => new Promise<void>((r) => (finish = r)),
      );
      const renew = jest.fn().mockResolvedValue(true);
      const lock: LockPort = {
        acquire: jest.fn().mockResolvedValue({
          key: OUTBOX_AGGREGATE_LEASE.global('a'),
          token: 't',
          renew,
          release: jest.fn().mockResolvedValue(true),
        }),
        health: jest.fn(),
      };
      const poll = relayWith(lock).relay();
      await jest.advanceTimersByTimeAsync(OUTBOX_PUBLISH_TIMEOUT_MS - 1);
      expect(renew.mock.calls.length).toBeGreaterThanOrEqual(
        1 +
          Math.floor((OUTBOX_PUBLISH_TIMEOUT_MS - 1) / LEASE_RENEW_INTERVAL_MS),
      );
      finish();
      await poll;
      expect(outbox.rows[0].status).toBe(OutboxStatus.DISPATCHED);
    } finally {
      jest.useRealTimers();
    }
  });

  it('fails a publish that exceeds the publish timeout', async () => {
    jest.useFakeTimers();
    try {
      outbox.add('a');
      broker.publish.mockImplementationOnce(() => new Promise(() => undefined));
      const poll = relayWith(new InMemoryLockAdapter()).relay();
      await jest.advanceTimersByTimeAsync(OUTBOX_PUBLISH_TIMEOUT_MS + 1);
      await poll;
      expect(outbox.rows[0].status).toBe(OutboxStatus.FAILED);
    } finally {
      jest.useRealTimers();
    }
  });

  it('asks for a wider candidate window than it relays', async () => {
    await relayWith(new InMemoryLockAdapter()).relay();
    expect(outbox.dueAggregates).toHaveBeenCalledWith(CANDIDATES_PER_POLL);
    expect(CANDIDATES_PER_POLL).toBeGreaterThan(AGGREGATES_PER_POLL);
  });

  it('relays at most a batch per poll and spreads instances over the window', async () => {
    for (let i = 0; i < CANDIDATES_PER_POLL; i += 1) outbox.add(`agg-${i}`);
    const lock = new InMemoryLockAdapter();
    const first = relayWith(lock);
    await first.relay();
    expect(published).toHaveLength(AGGREGATES_PER_POLL);
    const firstBatch = published.map((p) => p.payload);

    published = [];
    outbox.rows.forEach((r) => (r.status = OutboxStatus.PENDING));
    await relayWith(lock).relay();
    expect(published.map((p) => p.payload)).not.toEqual(firstBatch);
  });

  it('polls again at once after a full batch and waits after a partial one', async () => {
    jest.useFakeTimers();
    try {
      for (let i = 0; i < AGGREGATES_PER_POLL + 5; i += 1) outbox.add(`g-${i}`);
      const relay = relayWith(new InMemoryLockAdapter());
      relay.onApplicationBootstrap();
      await jest.advanceTimersByTimeAsync(OUTBOX_POLL_INTERVAL_MS);
      expect(outbox.dueAggregates).toHaveBeenCalledTimes(1);
      await jest.advanceTimersByTimeAsync(100);
      expect(outbox.dueAggregates).toHaveBeenCalledTimes(2);
      expect(published).toHaveLength(AGGREGATES_PER_POLL + 5);
      await jest.advanceTimersByTimeAsync(OUTBOX_POLL_INTERVAL_MS - 200);
      expect(outbox.dueAggregates).toHaveBeenCalledTimes(2);
      await relay.onModuleDestroy();
    } finally {
      jest.useRealTimers();
    }
  });

  it('stops the aggregate when a stale failure no longer applies', async () => {
    outbox.add('a');
    outbox.add('a');
    broker.publish.mockRejectedValueOnce(new Error('late'));
    outbox.markFailed.mockResolvedValueOnce(null as never);
    await relayWith(new InMemoryLockAdapter()).relay();
    expect(broker.publish).toHaveBeenCalledTimes(1);
  });

  // Reproduces the dead-lettering: with messaging disabled every publish
  // failed, so every row reached DEAD within a few polls.
  it('leaves rows pending, attempts untouched, while messaging is disabled', async () => {
    const row = outbox.add('user-1');
    broker.publish.mockRejectedValue(
      new CapabilityDisabledError('messaging', 'publish'),
    );
    const relay = relayWith(new InMemoryLockAdapter());
    for (let i = 0; i < 6; i += 1) await relay.relay();
    expect(row.status).toBe(OutboxStatus.PENDING);
    expect(row.attempts).toBe(0);
    expect(outbox.markFailed).not.toHaveBeenCalled();
  });

  // Reproduces the extra attempt: a published row whose dispatch mark failed
  // was recorded as a failed publish and could go DEAD.
  it('does not count a publish as failed when only the dispatch mark failed', async () => {
    const row = outbox.add('user-1');
    outbox.markDispatched.mockRejectedValueOnce(new Error('mongo blip'));
    await relayWith(new InMemoryLockAdapter()).relay();
    expect(broker.publish).toHaveBeenCalledTimes(1);
    expect(outbox.markFailed).not.toHaveBeenCalled();
    expect(row.attempts).toBe(0);
  });

  it('settles the head of every aggregate it worked on', async () => {
    outbox.add('a');
    outbox.add('b');
    await relayWith(new InMemoryLockAdapter()).relay();
    expect(outbox.settleHead.mock.calls.map(([id]) => id).sort()).toEqual([
      'a',
      'b',
    ]);
  });
});
