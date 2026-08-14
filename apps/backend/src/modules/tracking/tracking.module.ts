import { Module } from '@nestjs/common';
import { TrackingService } from './services/tracking.service';
import { TrackingRepository } from './repositories/tracking.repository';
import { TrackingController } from './controllers/tracking.controller';
import { TrackingProcessor } from './processors/tracking.processor';
import { SignatureGuard } from '../../common/guards/signature.guard';
import { ApiKeyService } from '../../common/guards/api-key.service';

/**
 * User-behavior tracking (埋点).
 *   Ingest:  REST POST /api/v1/track → Pulsar (direct, no outbox — lossy-tolerant)
 *   Sink:    TrackingProcessor → ClickHouse logs.user_behavior
 *   Reads:   gRPC TrackingService.GetInsights (registered in GrpcModule,
 *            like the other *.grpc.controller.ts handlers)
 */
@Module({
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
