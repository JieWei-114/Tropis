import { Module } from '@nestjs/common';
import { ApiKeyService } from '../../common/guards/api-key.service';
import { SignatureGuard } from '../../common/guards/signature.guard';
import { DedupModule } from '../../infrastructure/dedup/dedup.module';
import { RpcModule } from '../../infrastructure/rpc/rpc.module';
import { SigningModule } from '../../infrastructure/signing/signing.module';
import { TenantDirectoryModule } from '../../modules/tenant/tenant-directory.module';
import { TrackingController } from './controllers/tracking.controller';
import { TrackingRpcController } from './controllers/tracking.rpc.controller';
import { TrackingModule } from './tracking.module';

/** REST ingest /api/v1/track* and the public TrackingService RPC. */
@Module({
  imports: [
    TrackingModule,
    RpcModule.forRoot(),
    DedupModule.forRoot(),
    SigningModule.forRoot(),
    TenantDirectoryModule,
  ],
  controllers: [TrackingController],
  providers: [
    TrackingRpcController,
    // For @RequireSignature() on POST /v1/track/secure (docs/api-conventions.md)
    SignatureGuard,
    ApiKeyService,
  ],
})
export class TrackingApiModule {}
