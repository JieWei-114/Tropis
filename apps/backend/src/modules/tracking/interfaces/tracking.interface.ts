/** One user-behavior event as published to Pulsar (after server enrichment). */
export interface ITrackingEvent {
  eventId: string;
  eventName: string;
  anonymousId: string;
  userId?: string;
  sessionId: string;
  tenantId: string;
  page: string;
  referrer: string;
  userAgent: string;
  screen: string;
  props: Record<string, unknown>;
  /** Client-reported epoch ms. */
  timestamp: number;
  /** Server receipt epoch ms (enrichment). */
  receivedAt: number;
}

/** Row shape of logs.user_behavior. */
export interface ITrackingRow {
  event_id: string;
  event_name: string;
  anonymous_id: string;
  user_id: string;
  session_id: string;
  tenant_id: string;
  page: string;
  referrer: string;
  user_agent: string;
  screen: string;
  props: string;
  timestamp: number; // epoch ms — DateTime64(3)
}

export interface IPageCount {
  page: string;
  count: number;
}

export interface IEventCount {
  eventName: string;
  count: number;
}

export interface IDailyUnique {
  day: string; // YYYY-MM-DD
  uniques: number;
}

export interface IRecentTrackingEvent {
  eventId: string;
  eventName: string;
  anonymousId: string;
  userId: string;
  sessionId: string;
  page: string;
  props: string; // JSON string
  timestamp: number;
}

export interface ITrackingInsights {
  topPages: IPageCount[];
  eventsByName: IEventCount[];
  dailyUniques: IDailyUnique[];
  recent: IRecentTrackingEvent[];
}
