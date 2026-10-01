import type { MessageInitShape } from '@bufbuild/protobuf';
import type { HandlerContext, ServiceImpl } from '@connectrpc/connect';
import type { AnalyticsEventType } from '@tropis/shared';
import { Authorize } from '../../../common/authz/authorize.decorator';
import { AnalyticsService } from '../services/analytics.service';
import { RpcService } from '../../../infrastructure/rpc/rpc-service.decorator';
import { RpcAuthzService } from '../../../infrastructure/rpc/rpc-authz.service';
import { RpcValidate } from '../../../infrastructure/rpc/rpc-validate.decorator';
import {
  CreateEventRpcDto,
  MAX_MINUTES,
  MinutelyStatsRpcDto,
  parseJsonObject,
} from '../dto/analytics-rpc.dto';
import { ANALYTICS_RESOURCE } from '../constants/analytics.constants';
import {
  AnalyticsTransformer,
  type EventResponse,
  type MinutelyStatsResponse,
  type StatsResponse,
} from '../transformers/analytics.transformer';
import {
  AnalyticsService as AnalyticsServiceDesc,
  type CreateEventRequest,
  type MinutelyStatsRequest,
  type RecentRequest,
  type RecentResponseSchema,
  type StatsRequest,
} from '../../../gen/analytics/v1/analytics_pb';

/**
 * Implements tropis.analytics.v1.AnalyticsService
 * (proto/analytics/v1/analytics.proto).
 *
 * Every method requires a valid token and an `analytics` permission: `read`
 * for the three queries, `write` for CreateEvent. The tenant comes from the
 * verified token, never from a default.
 *
 * Try it:
 *   grpcurl -plaintext -H "authorization: Bearer $TOKEN" \
 *     -d '{"event_type":"page_view","user_id":"user-123","metadata":"{\"page\":\"/home\"}"}' \
 *     localhost:50051 tropis.analytics.v1.AnalyticsService/CreateEvent
 */
@RpcService(AnalyticsServiceDesc)
export class AnalyticsRpcController implements ServiceImpl<
  typeof AnalyticsServiceDesc
> {
  constructor(
    private readonly analyticsService: AnalyticsService,
    private readonly authz: RpcAuthzService,
  ) {}

  @Authorize(ANALYTICS_RESOURCE, 'write')
  @RpcValidate(CreateEventRpcDto)
  async createEvent(
    req: CreateEventRequest,
    ctx: HandlerContext,
  ): Promise<EventResponse> {
    const caller = this.authz.caller(ctx);
    const event = await this.analyticsService.create(caller.tenantId, {
      eventType: req.eventType as AnalyticsEventType,
      userId: req.userId,
      metadata: (req.metadata && parseJsonObject(req.metadata)) || {},
    });
    return AnalyticsTransformer.toRpcEvent(event);
  }

  @Authorize(ANALYTICS_RESOURCE, 'read')
  async getStats(
    _req: StatsRequest,
    ctx: HandlerContext,
  ): Promise<StatsResponse> {
    const caller = this.authz.caller(ctx);
    return AnalyticsTransformer.toRpcStats(
      await this.analyticsService.getStats(caller.tenantId),
    );
  }

  @Authorize(ANALYTICS_RESOURCE, 'read')
  async getRecent(
    _req: RecentRequest,
    ctx: HandlerContext,
  ): Promise<MessageInitShape<typeof RecentResponseSchema>> {
    const caller = this.authz.caller(ctx);
    const events = await this.analyticsService.getRecent(caller.tenantId);
    return { events: events.map((e) => AnalyticsTransformer.toRpcEvent(e)) };
  }

  @Authorize(ANALYTICS_RESOURCE, 'read')
  @RpcValidate(MinutelyStatsRpcDto)
  async getMinutelyStats(
    req: MinutelyStatsRequest,
    ctx: HandlerContext,
  ): Promise<MinutelyStatsResponse> {
    const caller = this.authz.caller(ctx);
    const rows = await this.analyticsService.getMinutelyStats(
      caller.tenantId,
      RpcAuthzService.clampLimit(req.minutes, 60, MAX_MINUTES),
    );
    return AnalyticsTransformer.toRpcMinutely(rows);
  }
}
