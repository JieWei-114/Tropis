/**
 * Canonical event shape — used by NestJS (publisher), Flink (consumer),
 * and any future service that reads from Pulsar.
 */
export interface AppEvent {
  eventId: string;
  eventType: string;
  userId: string;
  payload: string;   // JSON string
  timestamp: number; // Unix millis
}

export const EVENT_TYPES = {
  USER_CREATED:  'user.created',
  USER_UPDATED:  'user.updated',
  USER_DELETED:  'user.deleted',
} as const;

export type EventType = (typeof EVENT_TYPES)[keyof typeof EVENT_TYPES];

/**
 * Analytics event types accepted by the backend analytics pipeline.
 * Must stay in sync with `AnalyticsEventType` in
 * apps/backend/src/modules/analytics/schemas/event-log.schema.ts.
 */
export const ANALYTICS_EVENT_TYPES = {
  PAGE_VIEW: 'page_view',
  BUTTON_CLICK: 'button_click',
  API_CALL: 'api_call',
  ERROR: 'error',
  PURCHASE: 'purchase',
} as const;

export type AnalyticsEventType =
  (typeof ANALYTICS_EVENT_TYPES)[keyof typeof ANALYTICS_EVENT_TYPES];
