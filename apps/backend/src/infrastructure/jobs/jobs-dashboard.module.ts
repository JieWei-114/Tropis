import { Module } from '@nestjs/common';
import { BullmqDashboardModule } from './adapters/bullmq/bullmq-dashboard.module';

/** The queue dashboard: the local `all` role only, outside production, localhost only. */
@Module({ imports: [BullmqDashboardModule] })
export class JobsDashboardModule {}
