import { Module } from '@nestjs/common';
import { MessagingModule } from '../../infrastructure/messaging/messaging.module';
import { RealtimeModule } from '../../infrastructure/realtime/realtime.module';
import { AnalyticsModule } from './analytics.module';
import { AnalyticsProcessor } from './processors/analytics.processor';
import { AnalyticsSinkService } from './services/analytics-sink.service';

/** Broker → OLAP sink for analytics events. */
@Module({
  imports: [
    AnalyticsModule,
    MessagingModule.forRoot(),
    RealtimeModule.forRoot(),
  ],
  providers: [AnalyticsSinkService, AnalyticsProcessor],
})
export class AnalyticsWorkerModule {}
