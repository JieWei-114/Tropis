import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { EventLog, EventLogSchema } from './schemas/event-log.schema';
import { AnalyticsService } from './services/analytics.service';
import { EventLogRepository } from './repositories/event-log.repository';
import { AnalyticsRepository } from './repositories/analytics.repository';
import { AnalyticsProcessor } from './processors/analytics.processor';
import { AnalyticsScheduler } from './processors/analytics.scheduler';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: EventLog.name, schema: EventLogSchema },
    ]),
  ],
  providers: [
    AnalyticsService,
    EventLogRepository,
    AnalyticsRepository,
    AnalyticsProcessor,
    AnalyticsScheduler, // cron: hourly stats bust, 5-min heartbeat
  ],
  exports: [AnalyticsService],
})
export class AnalyticsModule {}
