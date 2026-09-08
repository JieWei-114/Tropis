import { Test } from '@nestjs/testing';
import { getModelToken } from '@nestjs/mongoose';
import { OutboxService } from '../outbox.service';
import { Outbox, OutboxStatus } from '../outbox.schema';

/**
 * Pins the explicit `nextAttemptAt` contract: the delay is computed on failure
 * and stored as a date, and the requeue query compares that date against the
 * clock. A backoff derived instead from an arithmetic expression over a
 * timestamp requeues every failed row on every poll, since `$add` over a
 * missing field yields null and `$lte: [null, <date>]` is true.
 */
describe('OutboxService retry backoff', () => {
  let service: OutboxService;
  let model: {
    updateOne: jest.Mock;
    updateMany: jest.Mock;
    findOne: jest.Mock;
  };

  beforeEach(async () => {
    model = {
      updateOne: jest.fn().mockResolvedValue({ modifiedCount: 1 }),
      updateMany: jest.fn().mockResolvedValue({ modifiedCount: 0 }),
      findOne: jest.fn().mockReturnValue({
        select: () => ({
          lean: () => ({ exec: () => Promise.resolve({ attempts: 2 }) }),
        }),
      }),
    };

    const module = await Test.createTestingModule({
      providers: [
        OutboxService,
        { provide: getModelToken(Outbox.name), useValue: model },
      ],
    }).compile();
    service = module.get(OutboxService);
  });

  it('markFailed schedules nextAttemptAt with exponential backoff', async () => {
    const before = Date.now();
    await service.markFailed('row-1', 'pulsar unreachable');

    const [, update] = model.updateOne.mock.calls[0] as [
      unknown,
      { $set: { nextAttemptAt: Date }; $inc: { attempts: number } },
    ];
    expect(update.$inc.attempts).toBe(1);
    // Third attempt (attempts 2 -> 3) => 5s * 2^2 = 20s out.
    const delay = update.$set.nextAttemptAt.getTime() - before;
    expect(delay).toBeGreaterThanOrEqual(20_000);
    expect(delay).toBeLessThan(21_000);
  });

  it('requeueFailed only takes rows whose nextAttemptAt is due', async () => {
    await service.requeueFailed(5);

    const [filter] = model.updateMany.mock.calls[0] as [
      {
        status: string;
        attempts: { $lt: number };
        nextAttemptAt: { $lte: Date };
      },
    ];
    expect(filter.status).toBe(OutboxStatus.FAILED);
    expect(filter.attempts).toEqual({ $lt: 5 });
    // The due check must be a real comparison against a stored date, not an
    // expression over a field that may be absent.
    expect(filter.nextAttemptAt.$lte).toBeInstanceOf(Date);
  });

  it('deadLetterExhausted moves rows past the ceiling to the terminal state', async () => {
    await service.deadLetterExhausted(5);

    const [filter, update] = model.updateMany.mock.calls[0] as [
      { status: string; attempts: { $gte: number } },
      { $set: { status: string } },
    ];
    expect(filter.attempts).toEqual({ $gte: 5 });
    expect(update.$set.status).toBe(OutboxStatus.DEAD);
  });
});
