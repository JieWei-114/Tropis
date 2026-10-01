import { Module } from '@nestjs/common';
import { makeCounterProvider } from '@willsoto/nestjs-prometheus';
import { DedupModule } from '../../infrastructure/dedup/dedup.module';
import { MessagingModule } from '../../infrastructure/messaging/messaging.module';
import { OlapModule } from '../../infrastructure/olap/olap.module';
import { TenantDirectoryModule } from '../../modules/tenant/tenant-directory.module';
import { TRACKING_DUPLICATES_METRIC } from './constants/tracking.constants';
import { TrackingRepository } from './repositories/tracking.repository';
import { TrackingService } from './services/tracking.service';

/**
 * User-behavior tracking (product analytics instrumentation).
 *   Ingest:  REST POST /api/v1/track → broker (direct, no outbox — lossy-tolerant)
 *            (TrackingApiModule, public role)
 *   Sink:    TrackingProcessor → OLAP logs.user_behavior
 *            (TrackingWorkerModule, worker role)
 *   Reads:   RPC TrackingService.GetInsights (TrackingApiModule)
 */
@Module({
  imports: [
    MessagingModule.forRoot(),
    DedupModule.forRoot(),
    OlapModule.forRoot(),
    TenantDirectoryModule,
  ],
  providers: [
    TrackingService,
    TrackingRepository,
    makeCounterProvider({
      name: TRACKING_DUPLICATES_METRIC,
      help: 'Tracking events dropped by the ingest dedup claim',
    }),
  ],
  exports: [TrackingService, TrackingRepository],
})
export class TrackingModule {}
