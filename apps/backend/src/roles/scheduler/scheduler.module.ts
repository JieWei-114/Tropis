import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { OutboxScheduleModule } from '../../infrastructure/outbox/outbox-schedule.module';
import { CoreModule } from '../shared/core.module';

/**
 * Scheduler role: cron triggers only. Each trigger enqueues a job that the
 * worker role runs, so the scheduler does no business work and any number
 * of replicas enqueue each tick once (job ids are per tick).
 */
@Module({
  imports: [CoreModule, ScheduleModule.forRoot(), OutboxScheduleModule],
})
export class SchedulerModule {}
