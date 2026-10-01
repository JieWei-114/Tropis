import { SpanKind } from '@opentelemetry/api';
import { Test } from '@nestjs/testing';
import { getModelToken } from '@nestjs/mongoose';
import { Types } from 'mongoose';
import {
  installTracing,
  TRACE_ID,
  TRACEPARENT,
} from '../../../common/observability/__tests__/harness';
import { runInExtractedSpan } from '../../../common/observability/propagation';
import { OutboxService } from '../outbox.service';
import { Outbox, OutboxHead, OutboxStatus } from '../outbox.schema';

const otel = installTracing();
afterAll(() => otel.shutdown());

describe('OutboxService', () => {
  let service: OutboxService;
  let model: {
    create: jest.Mock;
    updateOne: jest.Mock;
    updateMany: jest.Mock;
    distinct: jest.Mock;
  };
  let heads: { updateOne: jest.Mock; bulkWrite: jest.Mock };

  beforeEach(async () => {
    model = {
      create: jest.fn().mockResolvedValue([]),
      updateOne: jest
        .fn()
        .mockResolvedValue({ matchedCount: 1, modifiedCount: 1 }),
      updateMany: jest.fn().mockResolvedValue({ modifiedCount: 2 }),
      distinct: jest.fn(() => ({ exec: () => Promise.resolve(['user-1']) })),
    };
    heads = {
      updateOne: jest.fn().mockResolvedValue({}),
      bulkWrite: jest.fn().mockResolvedValue({ upsertedCount: 0 }),
    };
    const module = await Test.createTestingModule({
      providers: [
        OutboxService,
        { provide: getModelToken(Outbox.name), useValue: model },
        { provide: getModelToken(OutboxHead.name), useValue: heads },
      ],
    }).compile();
    service = module.get(OutboxService);
  });

  it('writes the event attributes, including the caller trace context', async () => {
    const id = await runInExtractedSpan(
      { traceparent: TRACEPARENT },
      'POST /api/users',
      { kind: SpanKind.SERVER },
      () =>
        service.write({
          topic: 't',
          aggregateId: 'user-1',
          type: 'user.created',
          tenantId: 'acme',
          data: { userId: 'user-1' },
        }),
    );

    const [[row]] = model.create.mock.calls[0] as [
      [Record<string, any>],
      unknown,
    ];
    expect(row.aggregateId).toBe('user-1');
    expect(row.payload).toEqual({ userId: 'user-1' });
    expect(row.event).toMatchObject({
      id,
      type: 'user.created',
      subject: 'user-1',
      tenantId: 'acme',
      schemaVersion: '1',
    });
    expect(row.event.time).toBeInstanceOf(Date);
    expect(row.event.traceparent).toMatch(new RegExp(`^00-${TRACE_ID}-`));
  });

  it('keeps a caller-supplied event id', async () => {
    await expect(
      service.write({
        topic: 't',
        aggregateId: 'a',
        id: 'evt-9',
        type: 'x.y.recorded',
        tenantId: 'acme',
        data: {},
      }),
    ).resolves.toBe('evt-9');
  });

  it('markFailed schedules the next attempt with exponential backoff', async () => {
    const before = Date.now();
    const status = await service.markFailed(
      { _id: new Types.ObjectId(), attempts: 2 } as never,
      'pulsar unreachable',
      5,
    );

    expect(status).toBe(OutboxStatus.FAILED);
    const [, update] = model.updateOne.mock.calls[0] as [
      unknown,
      { $set: { attempts: number; nextAttemptAt: Date; status: string } },
    ];
    expect(update.$set.attempts).toBe(3);
    // Third attempt => 5s * 2^2 = 20s out.
    const delay = update.$set.nextAttemptAt.getTime() - before;
    expect(delay).toBeGreaterThanOrEqual(20_000);
    expect(delay).toBeLessThan(21_000);
  });

  it('markFailed moves the row to DEAD on its last attempt', async () => {
    const status = await service.markFailed(
      { _id: new Types.ObjectId(), attempts: 4 } as never,
      'boom',
      5,
    );
    expect(status).toBe(OutboxStatus.DEAD);
    const [, update] = model.updateOne.mock.calls[0] as [
      unknown,
      { $set: { status: string; nextAttemptAt: Date | null } },
    ];
    expect(update.$set).toMatchObject({
      status: OutboxStatus.DEAD,
      nextAttemptAt: null,
    });
  });

  it('markFailed never moves a row that already left PENDING/FAILED', async () => {
    model.updateOne.mockResolvedValueOnce({
      matchedCount: 0,
      modifiedCount: 0,
    });
    const status = await service.markFailed(
      { _id: new Types.ObjectId(), attempts: 0 } as never,
      'late timeout',
      5,
    );
    const [filter] = model.updateOne.mock.calls[0] as [{ status: unknown }];
    expect(filter.status).toEqual({
      $in: [OutboxStatus.PENDING, OutboxStatus.FAILED],
    });
    expect(status).toBeNull();
  });

  it('markDispatched only transitions an open, undispatched row', async () => {
    await service.markDispatched(new Types.ObjectId().toString());
    const [filter] = model.updateOne.mock.calls[0] as [{ status: unknown }];
    expect(filter.status).toEqual({
      $in: [OutboxStatus.PENDING, OutboxStatus.FAILED],
    });
  });

  it('redrive puts only DEAD rows back to PENDING with a fresh budget', async () => {
    await expect(service.redrive({ aggregateId: 'agg' })).resolves.toBe(2);
    const [filter, update] = model.updateMany.mock.calls[0] as [
      Record<string, unknown>,
      { $set: Record<string, unknown> },
    ];
    expect(filter).toEqual({ aggregateId: 'agg', status: OutboxStatus.DEAD });
    expect(update.$set).toEqual({
      status: OutboxStatus.PENDING,
      attempts: 0,
      nextAttemptAt: null,
    });
  });

  it('skip moves only DEAD rows to SKIPPED', async () => {
    const id = new Types.ObjectId().toString();
    await service.skip({ id });
    const [filter, update] = model.updateMany.mock.calls[0] as [
      { _id: Types.ObjectId; status: string },
      { $set: { status: string; skippedAt: Date } },
    ];
    expect(filter._id.toString()).toBe(id);
    expect(filter.status).toBe(OutboxStatus.DEAD);
    expect(update.$set.status).toBe(OutboxStatus.SKIPPED);
  });

  it('rejects a malformed row id', async () => {
    await expect(service.skip({ id: 'nope' })).rejects.toThrow(
      'Invalid outbox row id',
    );
  });

  it('puts the aggregate in line in the same transaction as the row', async () => {
    const session = { id: 'tx' };
    await service.write(
      {
        topic: 't',
        aggregateId: 'agg-1',
        type: 'x.y.recorded',
        tenantId: 'acme',
        data: {},
      },
      session as never,
    );
    expect(heads.updateOne).toHaveBeenCalledWith(
      { _id: 'agg-1' },
      { $setOnInsert: { dueAt: expect.any(Date) }, $inc: { v: 1 } },
      { upsert: true, session },
    );
    expect(heads.updateOne.mock.invocationCallOrder[0]).toBeLessThan(
      model.create.mock.invocationCallOrder[0],
    );
  });

  // Reproduces the unbounded growth: dispatched and skipped rows were kept
  // forever and every poll scanned the open backlog.
  it('gives terminal rows an expiry for the retention TTL', async () => {
    const before = Date.now();
    await service.markDispatched(new Types.ObjectId().toString());
    const [, update] = model.updateOne.mock.calls[0] as [
      unknown,
      { $set: { expireAt: Date } },
    ];
    expect(update.$set.expireAt.getTime() - before).toBeGreaterThanOrEqual(
      7 * 24 * 60 * 60 * 1000 - 1000,
    );

    await service.skip({ aggregateId: 'agg' });
    const [, skipped] = model.updateMany.mock.calls[0] as [
      unknown,
      { $set: { expireAt: Date } },
    ];
    expect(skipped.$set.expireAt).toBeInstanceOf(Date);
  });

  it('requeues the heads of redriven aggregates', async () => {
    await service.redrive({ aggregateId: 'user-1' });
    expect(heads.bulkWrite).toHaveBeenCalledWith(
      [
        {
          updateOne: {
            filter: { _id: 'user-1' },
            update: { $set: { dueAt: expect.any(Date) }, $inc: { v: 1 } },
            upsert: true,
          },
        },
      ],
      { ordered: false },
    );
  });
});
