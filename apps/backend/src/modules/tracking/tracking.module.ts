import { Module } from '@nestjs/common';
import { TrackingService } from './services/tracking.service';
import { TrackingRepository } from './repositories/tracking.repository';
import { TrackingController } from './controllers/tracking.controller';
import { TrackingProcessor } from './processors/tracking.processor';
import { SignatureGuard } from '../../common/guards/signature.guard';
import { ApiKeyService } from '../../common/guards/api-key.service';
import { MetricsModule } from '../metrics/metrics.module';

/**
 * User-behavior tracking (product analytics instrumentation).
 *   Ingest:  REST POST /api/v1/track → Pulsar (direct, no outbox — lossy-tolerant)
 *   Sink:    TrackingProcessor → ClickHouse logs.user_behavior
 *   Reads:   gRPC TrackingService.GetInsights (registered in GrpcModule,
 *            like the other *.grpc.controller.ts handlers)
 */
@Module({
  // For the ingest dedup-drop counter.
  imports: [MetricsModule],
  controllers: [TrackingController],
  providers: [
    TrackingService,
    TrackingRepository,
    TrackingProcessor,
    // For @RequireSignature() on POST /v1/track/secure (docs/api-conventions.md)
    SignatureGuard,
    ApiKeyService,
  ],
  exports: [TrackingService],
})
export class TrackingModule {}
