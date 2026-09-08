import {
  ITrackingInsights,
  IRecentTrackingEvent,
} from '../interfaces/tracking.interface';

// ── gRPC response shapes (mirror proto/tracking/v1/tracking.proto) ──────────

export interface GrpcRecentTrackEvent {
  event_id: string;
  event_name: string;
  anonymous_id: string;
  user_id: string;
  session_id: string;
  page: string;
  props: string;
  timestamp: number;
}

export interface GrpcInsightsResponse {
  top_pages: { page: string; count: number }[];
  events_by_name: { event_name: string; count: number }[];
  daily_uniques: { day: string; uniques: number }[];
  recent: GrpcRecentTrackEvent[];
  funnel: { step: string; users: number }[];
}

export class TrackingTransformer {
  static toGrpcInsights(insights: ITrackingInsights): GrpcInsightsResponse {
    return {
      top_pages: insights.topPages,
      events_by_name: insights.eventsByName.map((e) => ({
        event_name: e.eventName,
        count: e.count,
      })),
      daily_uniques: insights.dailyUniques,
      recent: insights.recent.map(TrackingTransformer.toGrpcRecent),
      funnel: insights.funnel,
    };
  }

  private static toGrpcRecent(e: IRecentTrackingEvent): GrpcRecentTrackEvent {
    return {
      event_id: e.eventId,
      event_name: e.eventName,
      anonymous_id: e.anonymousId,
      user_id: e.userId,
      session_id: e.sessionId,
      page: e.page,
      props: e.props,
      timestamp: e.timestamp,
    };
  }
}
