/**
 * Event type names (the envelope `type`) of every event the backend
 * publishes. The user events keep their two-segment names; every other type
 * follows `<domain>.<entity>.<past-tense>` (envelope.ts).
 */
export const EVENT_TYPES = {
  USER_CREATED: 'user.created',
  USER_UPDATED: 'user.updated',
  USER_DELETED: 'user.deleted',
  ANALYTICS_EVENT_RECORDED: 'analytics.event.recorded',
  TRACKING_BATCH_RECEIVED: 'tracking.batch.received',
  /** A message whose publisher named no type. */
  MESSAGE_PUBLISHED: 'tropis.message.published',
} as const;

export type EventType = (typeof EVENT_TYPES)[keyof typeof EVENT_TYPES];

/**
 * Types that predate the `<domain>.<entity>.<past-tense>` rule. Every other
 * entry of EVENT_TYPES must conform (checked by the envelope tests).
 */
export const LEGACY_EVENT_TYPES: readonly EventType[] = [
  EVENT_TYPES.USER_CREATED,
  EVENT_TYPES.USER_UPDATED,
  EVENT_TYPES.USER_DELETED,
];

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
