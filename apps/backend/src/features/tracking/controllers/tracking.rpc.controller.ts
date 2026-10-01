import type { HandlerContext, ServiceImpl } from '@connectrpc/connect';
import { Authorize } from '../../../common/authz/authorize.decorator';
import { RpcService } from '../../../infrastructure/rpc/rpc-service.decorator';
import { RpcAuthzService } from '../../../infrastructure/rpc/rpc-authz.service';
import { RpcValidate } from '../../../infrastructure/rpc/rpc-validate.decorator';
import { InsightsRpcDto } from '../dto/tracking-rpc.dto';
import { TRACKING_INSIGHTS_RESOURCE } from '../constants/tracking.constants';
import { TrackingService } from '../services/tracking.service';
import {
  TrackingTransformer,
  type InsightsResponse,
} from '../transformers/tracking.transformer';
import {
  TrackingService as TrackingServiceDesc,
  type InsightsRequest,
} from '../../../gen/tracking/v1/tracking_pb';

/**
 * Implements tropis.tracking.v1.TrackingService
 * (proto/tracking/v1/tracking.proto). Read surface only; ingest is REST
 * (tracking.controller.ts). GetInsights requires a valid JWT and the
 * `analytics:read` permission, and scopes every query to the tenant in that
 * token, so one tenant's traffic is never shown to another.
 *
 * Try it:
 *   grpcurl -plaintext -H "authorization: Bearer $TOKEN" -d '{"days":7}' \
 *     localhost:50051 tropis.tracking.v1.TrackingService/GetInsights
 */
@RpcService(TrackingServiceDesc)
export class TrackingRpcController implements ServiceImpl<
  typeof TrackingServiceDesc
> {
  constructor(
    private readonly trackingService: TrackingService,
    private readonly authz: RpcAuthzService,
  ) {}

  @Authorize(TRACKING_INSIGHTS_RESOURCE, 'read')
  @RpcValidate(InsightsRpcDto)
  async getInsights(
    req: InsightsRequest,
    ctx: HandlerContext,
  ): Promise<InsightsResponse> {
    const caller = this.authz.caller(ctx);
    const insights = await this.trackingService.getInsights(
      caller.tenantId,
      req.days || undefined,
    );
    return TrackingTransformer.toInsightsResponse(insights);
  }
}
