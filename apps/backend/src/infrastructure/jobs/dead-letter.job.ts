import { Injectable } from '@nestjs/common';
import { createLogger } from '../../common/observability/logger';
import { JobHandler } from './job-handler.decorator';
import type { JobContext, JobProcessor } from './jobs.port';
import { QUEUE_DLQ } from './jobs.registry';

/**
 * Logs each job that exhausted its retries and holds it. Replay is an
 * operator action (devtools `jobs-dlq replay`), which retries the source job
 * or re-enqueues it with its recorded options.
 */
@Injectable()
@JobHandler(QUEUE_DLQ)
export class DeadLetterJob implements JobProcessor<Record<string, unknown>> {
  private readonly logger = createLogger('jobs');

  process(job: JobContext<Record<string, unknown>>): Promise<void> {
    this.logger.error(
      'dead-letter-received',
      'Job failed after all retries',
      undefined,
      {
        'job.name': job.name,
        'messaging.message.id': job.id,
        'job.source_queue': String(job.data.__sourceQueue),
        'job.fail_reason': failReason(job.data.__failReason),
      },
    );
    return Promise.resolve();
  }
}

function failReason(reason: unknown): string {
  if (reason === undefined || reason === null) return 'unknown';
  if (typeof reason === 'string') return reason;
  return JSON.stringify(reason) ?? 'unknown';
}
