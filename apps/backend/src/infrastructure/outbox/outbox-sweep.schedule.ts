import { Inject, Injectable } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { createLogger } from '../../common/observability/logger';
import { runGlobal } from '../../common/tenant/tenant.context';
import { JOBS, type JobsPort } from '../jobs/jobs.port';
import { OUTBOX_SWEEP_JOB, QUEUE_OUTBOX_MAINTENANCE } from './outbox.constants';

const MINUTE_MS = 60_000;

/**
 * Scheduler role: once a minute, enqueue the outbox sweep for a worker. The
 * job id is the minute, so extra scheduler replicas enqueue it only once.
 */
@Injectable()
export class OutboxSweepSchedule {
  private readonly logger = createLogger('outbox');

  constructor(@Inject(JOBS) private readonly jobs: JobsPort) {}

  @Cron(CronExpression.EVERY_MINUTE)
  async enqueue(): Promise<void> {
    const minute = Math.floor(Date.now() / MINUTE_MS);
    try {
      await runGlobal(() =>
        this.jobs.enqueue(
          QUEUE_OUTBOX_MAINTENANCE,
          OUTBOX_SWEEP_JOB,
          {},
          { jobId: `${OUTBOX_SWEEP_JOB}-${minute}` },
        ),
      );
    } catch (err) {
      this.logger.warn(
        'sweep-enqueue-failed',
        'Outbox sweep not enqueued',
        {},
        err,
      );
    }
  }
}
