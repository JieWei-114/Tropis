import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { CacheModule } from '../../infrastructure/cache/cache.module';
import { DocumentsModule } from '../../infrastructure/documents/documents.module';
import { OlapModule } from '../../infrastructure/olap/olap.module';
import { OutboxModule } from '../../infrastructure/outbox/outbox.module';
import { EventLog, EventLogSchema } from './schemas/event-log.schema';
import { AnalyticsService } from './services/analytics.service';
import { EventLogRepository } from './repositories/event-log.repository';
import { AnalyticsRepository } from './repositories/analytics.repository';

/**
 * Analytics without any transport. The RPC is AnalyticsApiModule, the event
 * sink AnalyticsWorkerModule.
 */
@Module({
  imports: [
    DocumentsModule.forRoot(),
    OutboxModule.forRoot(),
    CacheModule.forRoot(),
    OlapModule.forRoot(),
    MongooseModule.forFeature([
      { name: EventLog.name, schema: EventLogSchema },
    ]),
  ],
  providers: [AnalyticsService, EventLogRepository, AnalyticsRepository],
  exports: [AnalyticsService, EventLogRepository, AnalyticsRepository],
})
export class AnalyticsModule {}
