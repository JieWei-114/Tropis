import { Module } from '@nestjs/common';
import { makeGaugeProvider } from '@willsoto/nestjs-prometheus';
import { JobsModule } from '../jobs/jobs.module';
import { LockModule } from '../lock/lock.module';
import { MessagingModule } from '../messaging/messaging.module';
import {
  OUTBOX_BACKLOG_METRIC,
  OUTBOX_MAINTENANCE_QUEUE,
  OUTBOX_RELAY_LAST_POLL_METRIC,
} from './outbox.constants';
import { OutboxModule } from './outbox.module';
import { OutboxRelay } from './outbox.relay';
import { OutboxSweepJob } from './outbox-sweep.job';

/** Worker role: the relay loop, the sweep job and the gauges they publish. */
@Module({
  imports: [
    OutboxModule.forRoot(),
    MessagingModule.forRoot(),
    LockModule.forRoot(),
    JobsModule.forFeature([OUTBOX_MAINTENANCE_QUEUE]),
  ],
  providers: [
    OutboxRelay,
    OutboxSweepJob,
    makeGaugeProvider({
      name: OUTBOX_BACKLOG_METRIC,
      help: 'Outbox rows currently in each open status',
      labelNames: ['status'],
    }),
    makeGaugeProvider({
      name: OUTBOX_RELAY_LAST_POLL_METRIC,
      help: 'Unix timestamp of the last completed outbox relay poll',
    }),
  ],
})
export class OutboxRelayModule {}
