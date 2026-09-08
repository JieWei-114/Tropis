import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { getLoggerToken, PinoLogger } from 'nestjs-pino';
import { UserProcessor } from '../processors/user.processor';
import { USER_EVENTS } from '../constants/user.constants';
import { REDIS_CLIENT } from '../../../infrastructure/redis/redis.module';
import { MESSAGE_BROKER } from '../../../infrastructure/messaging/message-broker.port';
import { SearchService } from '../../../infrastructure/elasticsearch/search.service';
import { UserVectorService } from '../../../infrastructure/postgres/user-vector.service';
import { QueueService } from '../../../infrastructure/queue/queue.service';
import { TemporalService } from '../../../infrastructure/temporal/temporal.service';

/**
 * The created-user fan-out is the app's most consequential handler: it owns
 * the search index, the similarity vectors, the welcome email and the
 * onboarding workflow. A throw anywhere in it costs all four, so its contract
 * is worth pinning directly rather than only through the running stack.
 */
describe('UserProcessor', () => {
  let processor: UserProcessor;
  let redis: { set: jest.Mock; expire: jest.Mock; del: jest.Mock };
  let search: { index: jest.Mock; delete: jest.Mock };
  let vector: { upsertVector: jest.Mock; deleteVector: jest.Mock };
  let queue: { enqueueNotification: jest.Mock };
  let temporal: { available: boolean; startWorkflow: jest.Mock };

  const created = (userId = 'user-1') => ({
    eventType: USER_EVENTS.CREATED,
    eventId: 'evt-1',
    aggregateId: userId,
    payload: { userId, name: 'Ada', email: 'ada@example.com', age: 36 },
  });

  beforeEach(async () => {
    redis = {
      set: jest.fn().mockResolvedValue('OK'), // claim acquired
      expire: jest.fn().mockResolvedValue(1),
      del: jest.fn().mockResolvedValue(1),
    };
    search = {
      index: jest.fn().mockResolvedValue(undefined),
      delete: jest.fn().mockResolvedValue(undefined),
    };
    vector = {
      upsertVector: jest.fn().mockResolvedValue(undefined),
      deleteVector: jest.fn().mockResolvedValue(undefined),
    };
    queue = { enqueueNotification: jest.fn().mockResolvedValue(undefined) };
    temporal = {
      available: true,
      startWorkflow: jest.fn().mockResolvedValue({}),
    };

    const module = await Test.createTestingModule({
      providers: [
        UserProcessor,
        {
          provide: getLoggerToken(UserProcessor.name),
          useValue: {
            info: jest.fn(),
            warn: jest.fn(),
            error: jest.fn(),
            debug: jest.fn(),
          } as unknown as PinoLogger,
        },
        { provide: REDIS_CLIENT, useValue: redis },
        { provide: MESSAGE_BROKER, useValue: { subscribe: jest.fn() } },
        { provide: SearchService, useValue: search },
        { provide: UserVectorService, useValue: vector },
        { provide: QueueService, useValue: queue },
        { provide: TemporalService, useValue: temporal },
        {
          provide: ConfigService,
          useValue: { get: (_k: string, d: number) => d },
        },
      ],
    }).compile();

    processor = module.get(UserProcessor);
  });

  /** `handle` is the broker callback; it is private by design. */
  const handle = (msg: Record<string, unknown>) =>
    (
      processor as unknown as {
        handle: (m: Record<string, unknown>) => Promise<void>;
      }
    ).handle(msg);

  it('indexes, vectorises, emails and starts the onboarding workflow', async () => {
    await handle(created());

    expect(search.index).toHaveBeenCalledTimes(1);
    expect(vector.upsertVector).toHaveBeenCalledTimes(1);
    expect(queue.enqueueNotification).toHaveBeenCalledTimes(1);
    expect(temporal.startWorkflow).toHaveBeenCalledTimes(1);
  });

  it('uses a BullMQ-safe deterministic jobId for the welcome email', async () => {
    await handle(created('user-42'));

    const [, , opts] = queue.enqueueNotification.mock.calls[0] as [
      string,
      unknown,
      { jobId: string },
    ];
    // BullMQ rejects ':' in a custom id — it is its own key separator. A colon
    // here makes the handler throw ("Custom Id cannot contain :") on every
    // signup, costing the index, the vector, the email AND the workflow.
    expect(opts.jobId).not.toContain(':');
    expect(opts.jobId).toMatch(/^[A-Za-z0-9_-]+$/);
    // Deterministic, so a redelivery cannot send a second welcome email.
    expect(opts.jobId).toBe('welcome-user-42');
  });

  it('releases the dedup claim and rethrows when a sink fails, so the broker retries', async () => {
    search.index.mockRejectedValue(new Error('elasticsearch down'));

    await expect(handle(created())).rejects.toThrow('elasticsearch down');
    expect(redis.del).toHaveBeenCalled(); // claim released for the retry
    expect(redis.expire).not.toHaveBeenCalled(); // never committed
  });

  it('skips an event whose id was already claimed', async () => {
    redis.set.mockResolvedValue(null); // SET NX lost

    await handle(created());

    expect(search.index).not.toHaveBeenCalled();
    expect(queue.enqueueNotification).not.toHaveBeenCalled();
  });

  it('does not fail the handler when Temporal is unavailable', async () => {
    temporal.available = false;

    await expect(handle(created())).resolves.toBeUndefined();
    expect(temporal.startWorkflow).not.toHaveBeenCalled();
    expect(redis.expire).toHaveBeenCalled(); // still committed
  });
});
