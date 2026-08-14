import { Controller } from '@nestjs/common';
import { GrpcMethod, RpcException } from '@nestjs/microservices';
import { status as GrpcStatus } from '@grpc/grpc-js';
import * as jwt from 'jsonwebtoken';
import { ConfigService } from '@nestjs/config';
import { TrackingService } from '../services/tracking.service';
import {
  TrackingTransformer,
  GrpcInsightsResponse,
} from '../transformers/tracking.transformer';
import { extractToken } from '../../../infrastructure/grpc/grpc.utils';

interface InsightsRequest {
  days?: number;
}

/**
 * Implements TrackingService from proto/tracking/v1/tracking.proto.
 * Read surface only — ingest is REST (see tracking.controller.ts).
 * GetInsights requires a valid JWT (dashboard data, not public).
 *
 * Test with grpcurl:
 *   grpcurl -plaintext -proto proto/tracking/v1/tracking.proto \
 *     -H "authorization: Bearer $TOKEN" -d '{"days":7}' \
 *     localhost:50051 tropis.tracking.v1.TrackingService/GetInsights
 */
@Controller()
export class GrpcTrackingService {
  private readonly jwtSecret: string;

  constructor(
    private readonly trackingService: TrackingService,
    config: ConfigService,
  ) {
    this.jwtSecret = config.getOrThrow<string>('JWT_SECRET');
  }

  @GrpcMethod('TrackingService', 'GetInsights')
  async getInsights(
    data: InsightsRequest,
    metadata: unknown,
  ): Promise<GrpcInsightsResponse> {
    const token = extractToken(data, metadata);
    try {
      jwt.verify(token, this.jwtSecret);
    } catch {
      throw new RpcException({
        code: GrpcStatus.UNAUTHENTICATED,
        message: 'Invalid authorization token',
      });
    }

    const insights = await this.trackingService.getInsights(
      data.days || undefined,
    );
    return TrackingTransformer.toGrpcInsights(insights);
  }
}
