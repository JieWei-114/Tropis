import type { MessageInitShape } from '@bufbuild/protobuf';
import { timestampFromMs } from '@bufbuild/protobuf/wkt';
import type {
  EventResponseSchema,
  MinutelyStatsResponseSchema,
  StatsResponseSchema,
} from '../../../gen/analytics/v1/analytics_pb';
import { EventLogDocument } from '../schemas/event-log.schema';
import {
  IAnalyticsStats,
  IEventLog,
  IMinutelyStat,
} from '../interfaces/analytics.interface';

export type EventResponse = MessageInitShape<typeof EventResponseSchema>;
export type StatsResponse = MessageInitShape<typeof StatsResponseSchema>;
export type MinutelyStatsResponse = MessageInitShape<
  typeof MinutelyStatsResponseSchema
>;

/** Epoch milliseconds as the deprecated int64 fields declare. */
const int64 = (ms: number): bigint => BigInt(Math.trunc(ms));
/** Epoch milliseconds as the google.protobuf.Timestamp fields. */
const time = (ms: number) => timestampFromMs(Math.trunc(ms));

export class AnalyticsTransformer {
  static toResponse(doc: EventLogDocument): IEventLog {
    return {
      eventId: doc.eventId,
      eventType: doc.eventType,
      userId: doc.userId,
      metadata: doc.metadata,
      timestamp: doc.timestamp,
    };
  }

  static toRpcEvent(e: IEventLog): EventResponse {
    return {
      eventId: e.eventId,
      eventType: e.eventType,
      userId: e.userId,
      metadata: JSON.stringify(e.metadata ?? {}),
      timestamp: int64(e.timestamp),
      eventTime: time(e.timestamp),
    };
  }

  static toRpcStats(s: IAnalyticsStats): StatsResponse {
    return {
      totalEvents: s.totalEvents,
      byType: s.byType.map((b) => ({
        eventType: b.eventType,
        count: b.count,
        lastSeen: int64(b.lastSeen),
        lastSeenTime: time(b.lastSeen),
      })),
      cachedAt: int64(s.cachedAt),
      cacheTime: time(s.cachedAt),
      fromCache: s.fromCache,
    };
  }

  static toRpcMinutely(rows: IMinutelyStat[]): MinutelyStatsResponse {
    return {
      stats: rows.map((r) => ({
        windowMs: int64(r.windowMs),
        windowStartTime: time(r.windowMs),
        eventType: r.eventType,
        count: r.count,
      })),
    };
  }
}
