import {
  Inject,
  Injectable,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DiscoveryService, Reflector } from '@nestjs/core';
import { UnrecoverableError, Worker, type Job } from 'bullmq';
import { isPermanentFailure } from '../../../capability/permanent-failure';
import { createLogger } from '../../../../common/observability/logger';
import { JOB_HANDLER_METADATA } from '../../job-handler.decorator';
import { jobMetrics } from '../../job-metrics';
import { processWithTrace } from '../../job-trace';
import type { JobProcessor } from '../../jobs.port';
import {
  JOB_QUEUES,
  QUEUE_DLQ,
  type JobQueueRegistry,
} from '../../jobs.registry';
import { BULLMQ_SYSTEM } from './bullmq-jobs.adapter';
import { bullmqConnection } from './bullmq-options';
import { BullmqQueues } from './bullmq-queues';

/**
 * Runs every @JobHandler provider as a BullMQ worker on its queue.
 *
 * A permanent failure (isPermanentFailure: the input is wrong) is not
 * retried. When a job of a `deadLetter` queue fails its last attempt, or
 * fails permanently, it is copied to
 * QUEUE_DLQ with `__sourceQueue`, `__sourceJobId`, `__sourceOpts` and
 * `__failReason`, where DeadLetterJob logs it and an operator replays it with
 * the devtools `jobs-dlq` tool.
 */
@Injectable()
export class BullmqWorkersService
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = createLogger('jobs');
  private readonly workers: Worker[] = [];
  private readonly queues: BullmqQueues;

  constructor(
    private readonly discovery: DiscoveryService,
    private readonly reflector: Reflector,
    private readonly config: ConfigService,
    @Inject(JOB_QUEUES) private readonly registry: JobQueueRegistry,
  ) {
    this.queues = new BullmqQueues(bullmqConnection(config));
  }

  onApplicationBootstrap(): void {
    for (const wrapper of this.discovery.getProviders()) {
      const instance = wrapper.instance as unknown;
      const metatype = wrapper.metatype;
      if (!instance || !metatype) continue;
      const queue = this.reflector.get<string | undefined>(
        JOB_HANDLER_METADATA,
        metatype,
      );
      if (!queue) continue;
      this.start(queue, instance as JobProcessor);
    }
  }

  async onModuleDestroy(): Promise<void> {
    await Promise.all(
      this.workers.map((w) => w.close().catch(() => undefined)),
    );
    this.workers.length = 0;
    await this.queues.close();
  }

  private start(queue: string, handler: JobProcessor): void {
    const definition = this.registry.get(queue);
    const worker = new Worker(
      queue,
      (job: Job) => {
        const attempt = {
          id: job.id,
          name: job.name,
          data: job.data as unknown,
          attemptsMade: job.attemptsMade,
        };
        return processWithTrace(BULLMQ_SYSTEM, queue, attempt, (data) =>
          handler.process({ ...attempt, data }),
        ).catch((err: unknown) => {
          // Retrying cannot fix a permanent failure: fail it now, and the
          // failed handler dead-letters it.
          if (isPermanentFailure(err)) {
            throw new UnrecoverableError((err as Error).message);
          }
          throw err;
        });
      },
      { connection: bullmqConnection(this.config) },
    );
    worker.on('failed', (job, err) => {
      if (!job || !definition.deadLetter) return;
      void this.deadLetter(queue, job, err);
    });
    worker.on('error', (err) =>
      this.logger.warn(
        'worker-error',
        'Job worker errored',
        { 'messaging.destination.name': queue },
        err,
      ),
    );
    this.workers.push(worker);
    this.logger.info('worker-started', 'Job handler started', {
      'messaging.destination.name': queue,
      'job.handler': handler.constructor.name,
    });
  }

  /** After all retries are exhausted, move the job to the DLQ. */
  private async deadLetter(queue: string, job: Job, err: Error): Promise<void> {
    const attemptsLeft = (job.opts.attempts ?? 1) - (job.attemptsMade ?? 0);
    if (attemptsLeft > 0 && err?.name !== 'UnrecoverableError') return;
    const dlq = this.queues.get(QUEUE_DLQ);
    try {
      await dlq.add(
        job.name,
        {
          ...(job.data as Record<string, unknown>),
          __sourceQueue: queue,
          __sourceJobId: job.id,
          __sourceOpts: {
            attempts: job.opts.attempts,
            backoff: job.opts.backoff,
          },
          __failReason: err.message,
        },
        { removeOnComplete: false, removeOnFail: false },
      );
      jobMetrics().deadLettered.inc({ queue });
      this.logger.warn(
        'job-dead-lettered',
        'Job moved to the dead-letter queue after its last attempt',
        {
          'messaging.destination.name': queue,
          'messaging.message.id': job.id,
          'job.attempts_made': job.attemptsMade,
        },
        err,
      );
    } catch (dlqErr) {
      this.logger.error(
        'dead-letter-failed',
        'Job could not be moved to the dead-letter queue',
        dlqErr,
        {
          'messaging.destination.name': queue,
          'messaging.message.id': job.id,
        },
      );
    }
  }
}
