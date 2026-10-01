import { Injectable } from '@nestjs/common';
import { JobHandler } from '../jobs/job-handler.decorator';
import type { JobProcessor } from '../jobs/jobs.port';
import { QUEUE_OUTBOX_MAINTENANCE } from './outbox.constants';
import { OutboxRelay } from './outbox.relay';

/** Runs the outbox sweep the scheduler enqueues (outbox-sweep.schedule.ts). */
@Injectable()
@JobHandler(QUEUE_OUTBOX_MAINTENANCE)
export class OutboxSweepJob implements JobProcessor {
  constructor(private readonly relay: OutboxRelay) {}

  process(): Promise<void> {
    return this.relay.sweep();
  }
}
