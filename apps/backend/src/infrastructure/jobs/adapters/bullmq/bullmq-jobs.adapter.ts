import type { OnApplicationShutdown } from '@nestjs/common';
import { probeCapability, type CapabilityHealth } from '../../../capability';
import type {
  EnqueueOptions,
  EnqueuedJob,
  JobCounts,
  JobsPort,
} from '../../jobs.port';
import { enqueueWithTrace } from '../../job-trace';
import { QUEUE_DLQ, type JobQueueRegistry } from '../../jobs.registry';
import { toJobsOptions } from './bullmq-options';
import type { BullmqQueues } from './bullmq-queues';

/** `messaging.system` of job spans. */
export const BULLMQ_SYSTEM = 'bullmq';

/** JobsPort over BullMQ, for the queues in the registry. */
export class BullmqJobsAdapter implements JobsPort, OnApplicationShutdown {
  constructor(
    private readonly registry: JobQueueRegistry,
    private readonly queues: BullmqQueues,
  ) {}

  async enqueue<T>(
    queue: string,
    name: string,
    data: T,
    options: EnqueueOptions = {},
  ): Promise<EnqueuedJob> {
    const definition = this.registry.get(queue);
    const target = this.queues.get(queue);
    return enqueueWithTrace(
      BULLMQ_SYSTEM,
      queue,
      name,
      data,
      async (traced) => {
        const job = await target.add(
          name,
          traced,
          toJobsOptions({ ...definition.defaults, ...options }),
        );
        return { id: job.id };
      },
    );
  }

  async counts(queue: string): Promise<JobCounts> {
    this.registry.get(queue);
    const q = this.queues.get(queue);
    const [waiting, active, completed, failed] = await Promise.all([
      q.getWaitingCount(),
      q.getActiveCount(),
      q.getCompletedCount(),
      q.getFailedCount(),
    ]);
    return { waiting, active, completed, failed };
  }

  health(): Promise<CapabilityHealth> {
    return probeCapability('bullmq', async () => {
      await (await this.queues.get(QUEUE_DLQ).client).ping();
    });
  }

  onApplicationShutdown(): Promise<void> {
    return this.queues.close();
  }
}
