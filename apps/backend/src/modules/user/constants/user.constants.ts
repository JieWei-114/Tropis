import { ERROR_CODES, EVENT_TYPES } from '@tropis/shared';

export const USER_ERROR_CODES = {
  NOT_FOUND: ERROR_CODES.USER_NOT_FOUND,
  ALREADY_EXISTS: ERROR_CODES.USER_ALREADY_EXISTS,
  INVALID_STATUS: ERROR_CODES.USER_INVALID_STATUS,
  LAST_ADMIN: ERROR_CODES.USER_LAST_ADMIN,
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

/**
 * Single source of truth for the password floor, enforced in the command
 * handlers so it applies to BOTH transports. class-validator DTOs only run on
 * the REST route, so a gRPC-only rule would let callers create accounts the
 * login endpoint then rejects.
 */
export const PASSWORD_MIN_LENGTH = 8;

/**
 * Redis marker for an account whose status is not ACTIVE.
 *
 * Login checks `user.status` directly, but an access token already issued stays
 * valid for its full lifetime, so suspending an account did nothing to the
 * session already holding a token. JwtStrategy checks this marker on every
 * request, alongside the JTI blacklist it already reads — same round trip.
 */
export const suspendedKey = (userId: string) => `susp:${userId}`;

/** Marker TTL — must outlive the longest access token. */
export const SUSPENDED_TTL_SECONDS = 7 * 24 * 60 * 60;
