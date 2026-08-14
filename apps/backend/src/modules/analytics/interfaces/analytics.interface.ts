import { AnalyticsEventType } from '../schemas/event-log.schema';

export interface IEventLog {
  eventId: string;
  eventType: AnalyticsEventType;
  userId: string;
  metadata: Record<string, unknown>;
  timestamp: number;
}

export interface IEventTypeStat {
  eventType: string;
  count: number;
  lastSeen: number;
}

export interface IMinutelyStat {
  windowMs: number;
  eventType: string;
  count: number;
}

export interface IAnalyticsStats {
  totalEvents: number;
  byType: IEventTypeStat[];
  cachedAt: number;
  fromCache: boolean;
}
