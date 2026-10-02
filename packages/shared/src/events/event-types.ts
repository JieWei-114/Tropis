/**
 * Event type names (the envelope `type`) of every event the backend
 * publishes. Every type follows `<domain>.<entity>.<past-tense>` (envelope.ts).
 */
export const EVENT_TYPES = {
  USER_CREATED: 'identity.user.created',
  USER_UPDATED: 'identity.user.updated',
  USER_DELETED: 'identity.user.deleted',
  ANALYTICS_EVENT_RECORDED: 'analytics.event.recorded',
  TRACKING_BATCH_RECEIVED: 'tracking.batch.received',
  /** A message whose publisher named no type. */
  MESSAGE_PUBLISHED: 'tropis.message.published',
} as const;

export type EventType = (typeof EVENT_TYPES)[keyof typeof EVENT_TYPES];

export const LEGACY_EVENT_TYPES: Readonly<Record<string, EventType>> =
  Object.freeze({
    'user.created': EVENT_TYPES.USER_CREATED,
    'user.updated': EVENT_TYPES.USER_UPDATED,
    'user.deleted': EVENT_TYPES.USER_DELETED,
  });

/** The current name of an event type, resolving a legacy name to its successor. */
export function canonicalEventType(type: string): string {
  return Object.prototype.hasOwnProperty.call(LEGACY_EVENT_TYPES, type)
    ? LEGACY_EVENT_TYPES[type]
    : type;
}

/** Analytics event types (`data.eventType` of analytics.event.recorded). */
export const ANALYTICS_EVENT_TYPES = {
  PAGE_VIEW: 'page_view',
  BUTTON_CLICK: 'button_click',
  API_CALL: 'api_call',
  ERROR: 'error',
  PURCHASE: 'purchase',
} as const;

export type AnalyticsEventType =
  (typeof ANALYTICS_EVENT_TYPES)[keyof typeof ANALYTICS_EVENT_TYPES];

export function isAnalyticsEventType(
  value: unknown,
): value is AnalyticsEventType {
  return (
    typeof value === 'string' &&
    (Object.values(ANALYTICS_EVENT_TYPES) as string[]).includes(value)
  );
}
