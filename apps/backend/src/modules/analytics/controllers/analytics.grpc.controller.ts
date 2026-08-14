import { Controller } from '@nestjs/common';
import { GrpcMethod } from '@nestjs/microservices';
import * as jwt from 'jsonwebtoken';
import { ConfigService } from '@nestjs/config';
import { AnalyticsService } from '../services/analytics.service';
import { resolveAuthorizationHeader } from '../../../infrastructure/grpc/grpc.utils';
import { IEventLog, IAnalyticsStats } from '../interfaces/analytics.interface';
import { AnalyticsEventType } from '../schemas/event-log.schema';

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
 * All methods are public (no auth required).
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
@Controller()
export class GrpcAnalyticsService {
  private readonly jwtSecret: string;

  constructor(
    private readonly analyticsService: AnalyticsService,
    config: ConfigService,
  ) {
    this.jwtSecret = config.getOrThrow<string>('JWT_SECRET');
  }

  private resolveTenantId(metadata: unknown): string {
    const token = resolveAuthorizationHeader(metadata);
    if (!token) return 'default';
    try {
      const payload = jwt.verify(token, this.jwtSecret) as {
        tenantId?: string;
      };
      return payload.tenantId ?? 'default';
    } catch {
      return 'default';
    }
  }

  @GrpcMethod('AnalyticsService', 'CreateEvent')
  async createEvent(
    data: CreateEventRequest,
    metadata: unknown,
  ): Promise<EventResponse> {
    const event = await this.analyticsService.create({
      eventType: data.event_type as AnalyticsEventType,
      userId: data.user_id,
      metadata: data.metadata ? JSON.parse(data.metadata) : {},
      tenantId: this.resolveTenantId(metadata),
    });
    return toGrpcEvent(event);
  }

  @GrpcMethod('AnalyticsService', 'GetStats')
  async getStats(
    _data: StatsRequest,
    metadata: unknown,
  ): Promise<StatsResponse> {
    const stats = await this.analyticsService.getStats(
      this.resolveTenantId(metadata),
    );
    return toGrpcStats(stats);
  }

  @GrpcMethod('AnalyticsService', 'GetRecent')
  async getRecent(_data: RecentRequest): Promise<RecentResponse> {
    const events = await this.analyticsService.getRecent();
    return { events: events.map(toGrpcEvent) };
  }

  @GrpcMethod('AnalyticsService', 'GetMinutelyStats')
  async getMinutelyStats(data: { minutes?: number }): Promise<{
    stats: { window_ms: number; event_type: string; count: number }[];
  }> {
    const rows = await this.analyticsService.getMinutelyStats(
      data.minutes ?? 60,
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
