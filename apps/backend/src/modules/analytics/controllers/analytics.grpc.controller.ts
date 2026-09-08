import { Controller } from '@nestjs/common';
import { GrpcMethod } from '@nestjs/microservices';
import { AnalyticsService } from '../services/analytics.service';
import { extractToken } from '../../../infrastructure/grpc/grpc.utils';
import {
  GrpcAuthzService,
  type GrpcCaller,
} from '../../../infrastructure/grpc/grpc-authz.service';
import { IEventLog, IAnalyticsStats } from '../interfaces/analytics.interface';
import { AnalyticsEventType } from '../constants/analytics.enums';

// ── Request / Response shapes (mirror proto messages) ────────────────────────

interface CreateEventRequest {
  event_type: string;
  user_id: string;
  metadata?: string;
}
interface StatsRequest {}
interface RecentRequest {}

interface EventResponse {
  event_id: string;
  event_type: string;
  user_id: string;
  metadata: string;
  timestamp: number;
}
interface EventStat {
  event_type: string;
  count: number;
  last_seen: number;
}
interface StatsResponse {
  total_events: number;
  by_type: EventStat[];
  cached_at: number;
  from_cache: boolean;
}
interface RecentResponse {
  events: EventResponse[];
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function toGrpcEvent(e: IEventLog): EventResponse {
  return {
    event_id: e.eventId,
    event_type: e.eventType,
    user_id: e.userId,
    metadata: JSON.stringify(e.metadata ?? {}),
    timestamp: e.timestamp,
  };
}

function toGrpcStats(s: IAnalyticsStats): StatsResponse {
  return {
    total_events: s.totalEvents,
    by_type: s.byType.map((b) => ({
      event_type: b.eventType,
      count: b.count,
      last_seen: b.lastSeen,
    })),
    cached_at: s.cachedAt,
    from_cache: s.fromCache,
  };
}

/**
 * Implements the AnalyticsService defined in proto/analytics/v1/analytics.proto.
 *
 * Every method requires a valid token and an OPA `analytics` permission —
 * `read` for the three queries, `write` for CreateEvent. An unauthorized method
 * here lets anyone on the network dump event rows (with userIds and metadata)
 * and inject events straight into the ClickHouse pipeline.
 *
 * Test with grpcurl:
 *   # Fire an event
 *   grpcurl -plaintext -proto proto/analytics/v1/analytics.proto \
 *     -d '{"event_type":"page_view","user_id":"user-123","metadata":"{\"page\":\"/home\"}"}' \
 *     localhost:50051 tropis.analytics.v1.AnalyticsService/CreateEvent
 *
 *   # Get stats (last 24h from ClickHouse, cached 30s in Redis)
 *   grpcurl -plaintext -proto proto/analytics/v1/analytics.proto \
 *     localhost:50051 tropis.analytics.v1.AnalyticsService/GetStats
 *
 *   # Get recent events (last 20 from MongoDB)
 *   grpcurl -plaintext -proto proto/analytics/v1/analytics.proto \
 *     localhost:50051 tropis.analytics.v1.AnalyticsService/GetRecent
 */
/** Upper bound on the minutely-stats window a single call may request. */
const MAX_MINUTES = 24 * 60;

@Controller()
export class GrpcAnalyticsService {
  constructor(
    private readonly analyticsService: AnalyticsService,
    private readonly authz: GrpcAuthzService,
  ) {}

  /**
   * Authenticates and authorizes, and returns the caller so the tenant comes
   * from the verified token. It must never fall back to a default tenant for an
   * absent or invalid token: that hands anonymous callers real tenant data.
   */
  private authorize(
    data: unknown,
    metadata: unknown,
    action: 'read' | 'write',
  ): Promise<GrpcCaller> {
    return this.authz.assert(extractToken(data, metadata), 'analytics', action);
  }

  @GrpcMethod('AnalyticsService', 'CreateEvent')
  async createEvent(
    data: CreateEventRequest,
    metadata: unknown,
  ): Promise<EventResponse> {
    const caller = await this.authorize(data, metadata, 'write');
    const event = await this.analyticsService.create({
      eventType: data.event_type as AnalyticsEventType,
      userId: data.user_id,
      metadata: data.metadata ? JSON.parse(data.metadata) : {},
      tenantId: caller.tenantId,
    });
    return toGrpcEvent(event);
  }

  @GrpcMethod('AnalyticsService', 'GetStats')
  async getStats(
    data: StatsRequest,
    metadata: unknown,
  ): Promise<StatsResponse> {
    const caller = await this.authorize(data, metadata, 'read');
    const stats = await this.analyticsService.getStats(caller.tenantId);
    return toGrpcStats(stats);
  }

  @GrpcMethod('AnalyticsService', 'GetRecent')
  async getRecent(
    data: RecentRequest,
    metadata: unknown,
  ): Promise<RecentResponse> {
    const caller = await this.authorize(data, metadata, 'read');
    const events = await this.analyticsService.getRecent(caller.tenantId);
    return { events: events.map(toGrpcEvent) };
  }

  @GrpcMethod('AnalyticsService', 'GetMinutelyStats')
  async getMinutelyStats(
    data: { minutes?: number },
    metadata: unknown,
  ): Promise<{
    stats: { window_ms: number; event_type: string; count: number }[];
  }> {
    const caller = await this.authorize(data, metadata, 'read');
    const rows = await this.analyticsService.getMinutelyStats(
      GrpcAuthzService.clampLimit(data.minutes, 60, MAX_MINUTES),
      caller.tenantId,
    );
    return {
      stats: rows.map((r) => ({
        window_ms: r.windowMs,
        event_type: r.eventType,
        count: r.count,
      })),
    };
  }
}
