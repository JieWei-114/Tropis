import { Processor, WorkerHost, OnWorkerEvent } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Job, Queue } from 'bullmq';
import {
  QUEUE_DLQ,
  QUEUE_NOTIFICATION,
  QUEUE_FILE_PROCESSING,
} from './queue.constants';

/**
 * Dead-letter queue processor.
 *
 * Jobs land here when the source queue exhausts all retry attempts.
 * The processor logs the failure and exposes a replay endpoint via `replayJob()`.
 *
 * Replay flow:
 *   1. Admin calls QueueService.replayDlqJob(jobId)
 *   2. Job data is re-enqueued on the original queue with a fresh attempts counter
 *   3. DLQ job is removed
 */
@Processor(QUEUE_DLQ)
export class DlqProcessor extends WorkerHost {
  private readonly logger = new Logger(DlqProcessor.name);

  constructor(
    @InjectQueue(QUEUE_NOTIFICATION) private readonly notificationQueue: Queue,
    @InjectQueue(QUEUE_FILE_PROCESSING) private readonly fileQueue: Queue,
  ) {
    super();
  }

  async process(job: Job): Promise<void> {
    // DLQ jobs are logged and held — no automatic retry here.
    // An operator can inspect them via Bull Board (/api/queues) and trigger replay.
    this.logger.error(
      `DLQ: job "${job.name}" (id=${job.id}) from queue "${job.data.__sourceQueue}" failed after all retries. ` +
        `Reason: ${job.data.__failReason ?? 'unknown'}`,
    );
  }

  @OnWorkerEvent('failed')
  onFailed(job: Job, err: Error): void {
    this.logger.error(`DLQ job ${job.id} failed permanently: ${err.message}`);
  }

  /** Re-enqueue a DLQ job back on its original queue with a fresh attempt counter. */
  async replayJob(dlqJob: Job): Promise<void> {
    const { __sourceQueue, __failReason, ...originalData } =
      dlqJob.data as Record<string, unknown>;
    const queue =
      __sourceQueue === QUEUE_NOTIFICATION
        ? this.notificationQueue
        : this.fileQueue;

    await queue.add(dlqJob.name, originalData, {
      attempts: 3,
      backoff: { type: 'exponential', delay: 2000 },
    });
    await dlqJob.remove();

    this.logger.log(
      `Replayed DLQ job "${dlqJob.name}" (id=${dlqJob.id}) onto queue "${__sourceQueue as string}"`,
    );
  }
}
