import { ERROR_CODES, EVENT_TYPES } from '@tropis/shared';

export const USER_ERROR_CODES = {
  NOT_FOUND: ERROR_CODES.USER_NOT_FOUND,
  ALREADY_EXISTS: ERROR_CODES.USER_ALREADY_EXISTS,
  INVALID_STATUS: ERROR_CODES.USER_INVALID_STATUS,
} as const;

// Re-exported from the shared event registry — @tropis/shared is the source
// of truth for event-name strings (Flink/ClickHouse consumers depend on them).
export const USER_EVENTS = {
  CREATED: EVENT_TYPES.USER_CREATED,
  UPDATED: EVENT_TYPES.USER_UPDATED,
  DELETED: EVENT_TYPES.USER_DELETED,
} as const;

export const USER_TOPIC = 'persistent://public/default/user-events';

export const USER_PULSAR_SUBSCRIPTION = 'user-processor-sub';
