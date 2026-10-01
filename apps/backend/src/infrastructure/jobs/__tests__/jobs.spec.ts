import type { ConfigService } from '@nestjs/config';
import type { DiscoveryService, Reflector } from '@nestjs/core';
import { BullmqJobsAdapter } from '../adapters/bullmq/bullmq-jobs.adapter';
import type { BullmqQueues } from '../adapters/bullmq/bullmq-queues';
import { BullmqWorkersService } from '../adapters/bullmq/bullmq-workers.service';
import {
  NOTIFICATION_QUEUE,
  QUEUE_NOTIFICATION,
} from '../../../modules/notification/constants/notification.constants';
import {
  OUTBOX_MAINTENANCE_QUEUE,
  QUEUE_OUTBOX_MAINTENANCE,
} from '../../outbox/outbox.constants';
import { toTenantId } from '../../../common/keyspace';
import { runGlobal, runInTenant } from '../../../common/tenant/tenant.context';
import { JOB_TENANT_FIELD } from '../job-tenant';
import {
  JobQueueRegistry,
  QUEUE_DLQ,
  UnknownJobQueueError,
} from '../jobs.registry';

const workerHandlers: Record<string, (...args: unknown[]) => unknown> = {};
const createdQueues: Record<string, ReturnType<typeof mockQueue>> = {};
jest.mock('bullmq', () => ({
  Queue: jest.fn().mockImplementation((name: string) => {
    createdQueues[name] ??= mockQueue();
    return createdQueues[name];
  }),
  Worker: jest.fn().mockImplementation(() => ({
    on: (event: string, fn: (...args: unknown[]) => unknown) => {
      workerHandlers[event] = fn;
    },
    close: jest.fn().mockResolvedValue(undefined),
  })),
}));

function registry(): JobQueueRegistry {
  const r = new JobQueueRegistry();
  r.register(NOTIFICATION_QUEUE);
  r.register(OUTBOX_MAINTENANCE_QUEUE);
  return r;
}

const mockQueue = () => ({
  add: jest.fn().mockResolvedValue({ id: 'job-1' }),
  getWaitingCount: jest.fn().mockResolvedValue(2),
  getActiveCount: jest.fn().mockResolvedValue(1),
  getCompletedCount: jest.fn().mockResolvedValue(10),
  getFailedCount: jest.fn().mockResolvedValue(0),
  client: Promise.resolve({ ping: jest.fn().mockResolvedValue('PONG') }),
});

const ACME = { scope: 'tenant', tenantId: 'acme' };
const inAcme = <T>(fn: () => T): T => runInTenant(toTenantId('acme'), fn);

describe('BullmqJobsAdapter', () => {
  let queues: Record<string, ReturnType<typeof mockQueue>>;
  let adapter: BullmqJobsAdapter;

  beforeEach(() => {
    queues = {
      [QUEUE_NOTIFICATION]: mockQueue(),
      [QUEUE_OUTBOX_MAINTENANCE]: mockQueue(),
      [QUEUE_DLQ]: mockQueue(),
    };
    adapter = new BullmqJobsAdapter(registry(), {
      get: (name: string) => queues[name],
      close: jest.fn(),
    } as unknown as BullmqQueues);
  });

  it("applies the queue's registered defaults", async () => {
    await expect(
      inAcme(() =>
        adapter.enqueue(QUEUE_NOTIFICATION, 'send-notification', { a: 1 }),
      ),
    ).resolves.toEqual({ id: 'job-1' });
    expect(queues[QUEUE_NOTIFICATION].add).toHaveBeenCalledWith(
      'send-notification',
      { a: 1, [JOB_TENANT_FIELD]: ACME },
      {
        attempts: 3,
        backoff: { type: 'exponential', delay: 2000 },
        removeOnComplete: 100,
        removeOnFail: 500,
      },
    );
  });

  it('merges caller options over the defaults', async () => {
    await inAcme(() =>
      adapter.enqueue(
        QUEUE_NOTIFICATION,
        'n',
        {},
        {
          priority: 1,
          jobId: 'welcome-u1',
          delayMs: 30_000,
        },
      ),
    );
    expect(queues[QUEUE_NOTIFICATION].add).toHaveBeenCalledWith(
      'n',
      { [JOB_TENANT_FIELD]: ACME },
      expect.objectContaining({
        priority: 1,
        jobId: 'welcome-u1',
        delay: 30_000,
        attempts: 3,
      }),
    );
  });

  it('uses the outbox-maintenance defaults for that queue', async () => {
    await inAcme(() => adapter.enqueue(QUEUE_OUTBOX_MAINTENANCE, 'sweep', {}));
    expect(queues[QUEUE_OUTBOX_MAINTENANCE].add).toHaveBeenCalledWith(
      'sweep',
      { [JOB_TENANT_FIELD]: ACME },
      expect.objectContaining({ attempts: 1, removeOnComplete: 10 }),
    );
  });

  it('rejects an unregistered queue', async () => {
    await expect(
      inAcme(() => adapter.enqueue('nope', 'x', {})),
    ).rejects.toBeInstanceOf(UnknownJobQueueError);
  });

  it('rejects an enqueue with no tenant and no global scope', async () => {
    await expect(
      adapter.enqueue(QUEUE_NOTIFICATION, 'n', {}),
    ).rejects.toMatchObject({ code: 'TENANT_REQUIRED' });
    expect(queues[QUEUE_NOTIFICATION].add).not.toHaveBeenCalled();
  });

  it('marks a job enqueued inside runGlobal as global', async () => {
    await runGlobal(() => adapter.enqueue(QUEUE_NOTIFICATION, 'n', {}));
    expect(queues[QUEUE_NOTIFICATION].add).toHaveBeenCalledWith(
      'n',
      { [JOB_TENANT_FIELD]: { scope: 'global' } },
      expect.anything(),
    );
  });

  it('returns queue counts', async () => {
    await expect(adapter.counts(QUEUE_NOTIFICATION)).resolves.toEqual({
      waiting: 2,
      active: 1,
      completed: 10,
      failed: 0,
    });
  });

  it('reports up when the queue connection answers', async () => {
    await expect(adapter.health()).resolves.toEqual({
      status: 'up',
      adapter: 'bullmq',
    });
  });
});

describe('BullmqWorkersService', () => {
  class Handler {
    process = jest.fn().mockResolvedValue(undefined);
  }

  beforeEach(() => {
    for (const key of Object.keys(createdQueues)) delete createdQueues[key];
  });

  const start = (queue: string) => {
    const handler = new Handler();
    createdQueues[QUEUE_DLQ] = mockQueue();
    const discovery = {
      getProviders: () => [{ instance: handler, metatype: Handler }],
    } as unknown as DiscoveryService;
    const reflector = { get: () => queue } as unknown as Reflector;
    const config = {
      get: () => undefined,
      getOrThrow: () => 'localhost',
    } as unknown as ConfigService;
    const service = new BullmqWorkersService(
      discovery,
      reflector,
      config,
      registry(),
    );
    service.onApplicationBootstrap();
    return { handler, dlq: createdQueues[QUEUE_DLQ] };
  };

  const job = (attemptsMade: number) => ({
    id: 'j1',
    name: 'send-notification',
    data: { userId: 'u1' },
    attemptsMade,
    opts: { attempts: 3, backoff: { type: 'exponential', delay: 2000 } },
  });

  it('moves a job to the DLQ once its last attempt fails', async () => {
    const { dlq } = start(QUEUE_NOTIFICATION);
    await workerHandlers.failed(job(3), new Error('smtp down'));
    await new Promise((r) => setImmediate(r));

    expect(dlq.add).toHaveBeenCalledWith(
      'send-notification',
      {
        userId: 'u1',
        __sourceQueue: QUEUE_NOTIFICATION,
        __sourceJobId: 'j1',
        __sourceOpts: {
          attempts: 3,
          backoff: { type: 'exponential', delay: 2000 },
        },
        __failReason: 'smtp down',
      },
      { removeOnComplete: false, removeOnFail: false },
    );
  });

  it('leaves a job with attempts left to BullMQ retries', async () => {
    const { dlq } = start(QUEUE_NOTIFICATION);
    await workerHandlers.failed(job(1), new Error('flaky'));
    await new Promise((r) => setImmediate(r));
    expect(dlq.add).not.toHaveBeenCalled();
  });

  it('dead-letters a permanently failed job at once, attempts left or not', async () => {
    const { dlq } = start(QUEUE_NOTIFICATION);
    const permanent = Object.assign(new Error('invalid recipient'), {
      name: 'UnrecoverableError',
    });
    await workerHandlers.failed(job(1), permanent);
    await new Promise((r) => setImmediate(r));
    expect(dlq.add).toHaveBeenCalled();
  });

  it('does not dead-letter queues registered without deadLetter', async () => {
    const { dlq } = start(QUEUE_OUTBOX_MAINTENANCE);
    await workerHandlers.failed(job(3), new Error('boom'));
    await new Promise((r) => setImmediate(r));
    expect(dlq.add).not.toHaveBeenCalled();
  });
});
