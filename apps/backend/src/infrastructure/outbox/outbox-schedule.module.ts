import { Module } from '@nestjs/common';
import { JobsModule } from '../jobs/jobs.module';
import { OUTBOX_MAINTENANCE_QUEUE } from './outbox.constants';
import { OutboxSweepSchedule } from './outbox-sweep.schedule';

/** Scheduler role: enqueues the outbox sweep once a minute. */
@Module({
  imports: [JobsModule.forFeature([OUTBOX_MAINTENANCE_QUEUE])],
  providers: [OutboxSweepSchedule],
})
export class OutboxScheduleModule {}
