import { AppError } from '../../../common/errors/app-error';
import {
  currentTenant,
  isGlobalScope,
  runGlobal,
  runInTenant,
} from '../../../common/tenant/tenant.context';
import {
  TENANT_A,
  uniqueId,
} from '../../capability/__tests__/conformance-helpers';
import type { JobContext, JobProcessor, JobsPort } from '../jobs.port';
import {
  JobQueueRegistry,
  QUEUE_DLQ,
  UnknownJobQueueError,
  type JobQueueDefinition,
} from '../jobs.registry';

/** A queue that retries and dead-letters, like a product notification queue. */
const QUEUE_RETRY = 'conformance-retry';
/** A one-attempt queue without dead-lettering, like a maintenance queue. */
const QUEUE_ONCE = 'conformance-once';

const CONFORMANCE_QUEUES: JobQueueDefinition[] = [
  {
    name: QUEUE_RETRY,
    defaults: {
      attempts: 3,
      backoff: { type: 'exponential', delayMs: 2000 },
      removeOnComplete: 100,
      removeOnFail: 500,
    },
    deadLetter: true,
  },
  {
    name: QUEUE_ONCE,
    defaults: { attempts: 1, removeOnComplete: 10, removeOnFail: 50 },
    deadLetter: false,
  },
];

/**
 * Setup for the jobs suite: the adapter must serve the queues in `registry`
 * and run `processors` (one per queue) as the consumers, as it runs
 * @JobHandler providers.
 */
export interface JobsConformanceTarget {
  make(
    processors: ReadonlyMap<string, JobProcessor>,
    registry: JobQueueRegistry,
  ): Promise<JobsPort>;
  teardown?(port: JobsPort): Promise<void> | void;
}

interface Attempt {
  job: JobContext;
  tenant: string | undefined;
  global: boolean;
}

type Behaviour = (job: JobContext) => Promise<void>;

/** Routes each attempt by job name to the test that enqueued it. */
class Router implements JobProcessor {
  readonly attempts = new Map<string, Attempt[]>();
  private readonly behaviours = new Map<string, Behaviour>();
  private readonly waiters = new Map<string, () => void>();

  on(name: string, behaviour: Behaviour = () => Promise.resolve()): void {
    this.behaviours.set(name, behaviour);
  }

  seen(name: string): Attempt[] {
    return this.attempts.get(name) ?? [];
  }

  until(name: string, count: number, timeoutMs = 20_000): Promise<Attempt[]> {
    return new Promise((resolve, reject) => {
      const check = () => {
        if (this.seen(name).length >= count) {
          this.waiters.delete(name);
          clearTimeout(timer);
          resolve(this.seen(name));
          return true;
        }
        return false;
      };
      const timer = setTimeout(
        () =>
          reject(
            new Error(
              `${name}: ${this.seen(name).length} of ${count} attempts after ${timeoutMs}ms`,
            ),
          ),
        timeoutMs,
      );
      if (!check()) this.waiters.set(name, () => void check());
    });
  }

  async process(job: JobContext): Promise<void> {
    const list = this.attempts.get(job.name) ?? [];
    list.push({ job, tenant: currentTenant(), global: isGlobalScope() });
    this.attempts.set(job.name, list);
    this.waiters.get(job.name)?.();
    await (this.behaviours.get(job.name) ?? (() => Promise.resolve()))(job);
  }
}

const inTenant = <T>(fn: () => Promise<T>) => runInTenant(TENANT_A, fn);

/** Behaviour every JobsPort adapter must share. */
export function describeJobsPort(
  adapter: string,
  target: JobsConformanceTarget,
): void {
  describe(`JobsPort conformance: ${adapter}`, () => {
    let jobs: JobsPort;
    const notification = new Router();
    const maintenance = new Router();
    const deadLetter = new Router();

    beforeAll(async () => {
      const registry = new JobQueueRegistry();
      for (const queue of CONFORMANCE_QUEUES) registry.register(queue);
      jobs = await target.make(
        new Map<string, JobProcessor>([
          [QUEUE_RETRY, notification],
          [QUEUE_ONCE, maintenance],
          [QUEUE_DLQ, deadLetter],
        ]),
        registry,
      );
    });

    afterAll(async () => {
      await target.teardown?.(jobs);
    });

    it('reports up', async () => {
      expect((await jobs.health()).status).toBe('up');
    });

    it("runs a job with its data inside the enqueuer's tenant", async () => {
      const name = `run-${uniqueId()}`;
      notification.on(name);
      const { id } = await inTenant(() =>
        jobs.enqueue(QUEUE_RETRY, name, { userId: 'u1' }),
      );
      expect(id).toBeDefined();

      const [attempt] = await notification.until(name, 1);
      expect(attempt.job.data).toEqual({ userId: 'u1' });
      expect(attempt.job.id).toBe(id);
      expect(attempt.tenant).toBe(TENANT_A);
    });

    it('runs a job enqueued in the global scope globally', async () => {
      const name = `global-${uniqueId()}`;
      maintenance.on(name);
      await runGlobal(() => jobs.enqueue(QUEUE_ONCE, name, {}));

      const [attempt] = await maintenance.until(name, 1);
      expect(attempt.tenant).toBeUndefined();
      expect(attempt.global).toBe(true);
    });

    it('refuses to enqueue outside a tenant or global scope', async () => {
      const err = await jobs
        .enqueue(QUEUE_RETRY, 'unscoped', {})
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(AppError);
      expect((err as AppError).code).toBe('TENANT_REQUIRED');
    });

    it('rejects an unregistered queue', async () => {
      await expect(
        inTenant(() => jobs.enqueue('no-such-queue', 'x', {})),
      ).rejects.toThrow(UnknownJobQueueError);
      await expect(jobs.counts('no-such-queue')).rejects.toThrow(
        UnknownJobQueueError,
      );
    });

    it('drops a second enqueue with the same job id', async () => {
      const name = `dedupe-${uniqueId()}`;
      const jobId = `conformance-${uniqueId()}`;
      notification.on(name);
      const first = await inTenant(() =>
        jobs.enqueue(QUEUE_RETRY, name, { n: 1 }, { jobId }),
      );
      const second = await inTenant(() =>
        jobs.enqueue(QUEUE_RETRY, name, { n: 2 }, { jobId }),
      );
      expect(first.id).toBe(jobId);
      expect(second.id).toBe(jobId);

      await notification.until(name, 1);
      await new Promise((r) => setTimeout(r, 500));
      expect(notification.seen(name).map((a) => a.job.data)).toEqual([
        { n: 1 },
      ]);
    });

    it('retries a failed attempt with its attempt count', async () => {
      const name = `retry-${uniqueId()}`;
      notification.on(name, (job) =>
        job.attemptsMade === 0
          ? Promise.reject(new Error('transient'))
          : Promise.resolve(),
      );
      await inTenant(() =>
        jobs.enqueue(
          QUEUE_RETRY,
          name,
          {},
          { attempts: 2, backoff: { type: 'fixed', delayMs: 100 } },
        ),
      );

      const attempts = await notification.until(name, 2);
      expect(attempts.map((a) => a.job.attemptsMade)).toEqual([0, 1]);
      expect(attempts.every((a) => a.tenant === TENANT_A)).toBe(true);
    });

    it('moves a job that exhausts its attempts to the dead-letter queue, in its tenant', async () => {
      const name = `dead-${uniqueId()}`;
      notification.on(name, () => Promise.reject(new Error('permanent')));
      deadLetter.on(name);
      await inTenant(() =>
        jobs.enqueue(QUEUE_RETRY, name, { userId: 'u9' }, { attempts: 1 }),
      );

      const [dead] = await deadLetter.until(name, 1);
      expect(dead.tenant).toBe(TENANT_A);
      expect(dead.job.data).toMatchObject({
        userId: 'u9',
        __sourceQueue: QUEUE_RETRY,
        __failReason: 'permanent',
      });
    });

    it('does not dead-letter a queue registered without deadLetter', async () => {
      const name = `kept-${uniqueId()}`;
      maintenance.on(name, () => Promise.reject(new Error('boom')));
      await runGlobal(() => jobs.enqueue(QUEUE_ONCE, name, {}));

      await maintenance.until(name, 1);
      await new Promise((r) => setTimeout(r, 500));
      expect(deadLetter.seen(name)).toEqual([]);
      expect((await jobs.counts(QUEUE_ONCE)).failed).toBeGreaterThanOrEqual(1);
    });

    it('counts completed jobs', async () => {
      const counts = await jobs.counts(QUEUE_RETRY);
      expect(counts.completed).toBeGreaterThanOrEqual(1);
      expect(counts).toEqual(
        expect.objectContaining({
          waiting: expect.any(Number),
          active: expect.any(Number),
          failed: expect.any(Number),
        }),
      );
    });
  });
}
