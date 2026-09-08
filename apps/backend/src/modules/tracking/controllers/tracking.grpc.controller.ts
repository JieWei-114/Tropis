import { Controller } from '@nestjs/common';
import { GrpcMethod } from '@nestjs/microservices';
import { TrackingService } from '../services/tracking.service';
import {
  TrackingTransformer,
  GrpcInsightsResponse,
} from '../transformers/tracking.transformer';
import { extractToken } from '../../../infrastructure/grpc/grpc.utils';
import { GrpcAuthzService } from '../../../infrastructure/grpc/grpc-authz.service';

interface InsightsRequest {
  days?: number;
}

/**
 * Implements TrackingService from proto/tracking/v1/tracking.proto.
 * Read surface only — ingest is REST (see tracking.controller.ts).
 * GetInsights requires a valid JWT AND the `analytics:read` permission, and
 * scopes every query to the tenant in that token — the queries read
 * logs.user_behavior, which carries tenant_id, but none of them filtered on it,
 * so the behaviour dashboard showed every tenant's traffic to everyone.
 *
 * Test with grpcurl:
 *   grpcurl -plaintext -proto proto/tracking/v1/tracking.proto \
 *     -H "authorization: Bearer $TOKEN" -d '{"days":7}' \
 *     localhost:50051 tropis.tracking.v1.TrackingService/GetInsights
 */
@Controller()
export class GrpcTrackingService {
  constructor(
    private readonly trackingService: TrackingService,
    private readonly authz: GrpcAuthzService,
  ) {}

  @GrpcMethod('TrackingService', 'GetInsights')
  async getInsights(
    data: InsightsRequest,
    metadata: unknown,
  ): Promise<GrpcInsightsResponse> {
    const caller = await this.authz.assert(
      extractToken(data, metadata),
      'analytics',
      'read',
    );

    const insights = await this.trackingService.getInsights(
      data.days || undefined,
      caller.tenantId,
    );
    return TrackingTransformer.toGrpcInsights(insights);
  }
}
