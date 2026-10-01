import type { MessageInitShape } from '@bufbuild/protobuf';
import { timestampFromMs } from '@bufbuild/protobuf/wkt';
import type { InsightsResponseSchema } from '../../../gen/tracking/v1/tracking_pb';
import type { ITrackingInsights } from '../interfaces/tracking.interface';

export type InsightsResponse = MessageInitShape<typeof InsightsResponseSchema>;

/** Insights → tropis.tracking.v1.InsightsResponse. */
export class TrackingTransformer {
  static toInsightsResponse(insights: ITrackingInsights): InsightsResponse {
    return {
      topPages: insights.topPages.map((p) => ({
        page: p.page,
        count: p.count,
      })),
      eventsByName: insights.eventsByName.map((e) => ({
        eventName: e.eventName,
        count: e.count,
      })),
      dailyUniques: insights.dailyUniques.map((d) => ({
        day: d.day,
        uniques: d.uniques,
      })),
      recent: insights.recent.map((e) => ({
        eventId: e.eventId,
        eventName: e.eventName,
        anonymousId: e.anonymousId,
        userId: e.userId,
        sessionId: e.sessionId,
        page: e.page,
        props: e.props,
        timestamp: BigInt(Math.trunc(e.timestamp)),
        eventTime: timestampFromMs(Math.trunc(e.timestamp)),
      })),
      funnel: insights.funnel.map((s) => ({ step: s.step, users: s.users })),
    };
  }
}
