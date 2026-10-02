import { ERROR_CODES, EVENT_TYPES, USER_EVENTS_TOPIC } from '@tropis/shared';
import { defineKey } from '../../../common/keyspace';

export const USER_ERROR_CODES = {
  NOT_FOUND: ERROR_CODES.USER_NOT_FOUND,
  ALREADY_EXISTS: ERROR_CODES.USER_ALREADY_EXISTS,
  LAST_ADMIN: ERROR_CODES.USER_LAST_ADMIN,
} as const;

/** The user events contract lives in @tropis/shared (events/user-events.ts). */
export const USER_EVENTS = {
  CREATED: EVENT_TYPES.USER_CREATED,
  UPDATED: EVENT_TYPES.USER_UPDATED,
  DELETED: EVENT_TYPES.USER_DELETED,
} as const;

export const USER_TOPIC = USER_EVENTS_TOPIC;

/** Realtime push names (the WebSocket contract), distinct from the event types. */
export const USER_REALTIME_EVENTS = {
  CREATED: 'user.created',
  UPDATED: 'user.updated',
} as const;

/** Authorization resource of user records (infra/opa/authz.rego). */
export const USER_RESOURCE = 'user';

export const USER_SUBSCRIPTION = 'user-processor-sub';

/**
 * Single source of truth for the password floor, enforced in the command
 * handlers so it applies to BOTH transports. class-validator DTOs only run on
 * the REST route, so a gRPC-only rule would let callers create accounts the
 * login endpoint then rejects.
 */
export const PASSWORD_MIN_LENGTH = 8;

/** bcrypt reads at most 72 bytes; anything far longer is refused outright. */
export const PASSWORD_MAX_LENGTH = 128;

/**
 * Marker for an account whose status is not ACTIVE: forTenant(tenantId, userId).
 *
 * Set on suspension and read by the TokenVerifier on every REST, RPC and
 * WebSocket authentication, next to the member record's own status, so a
 * suspension takes effect on tokens issued before it.
 */
export const ACCOUNT_SUSPENDED_KEY = defineKey({
  capability: 'kv',
  module: 'user',
  name: 'account-suspended',
  version: 'v1',
});

/** Marker TTL — must outlive the longest access token. */
export const SUSPENDED_TTL_SECONDS = 7 * 24 * 60 * 60;

/** Read cache of one user's public profile: forTenant(tenantId, userId). */
export const USER_PROFILE_CACHE = defineKey({
  capability: 'cache',
  module: 'user',
  name: 'profile',
  version: 'v1',
});

export const USER_PROFILE_CACHE_TTL_SECONDS = 300;

/**
 * Idempotent create: forTenant(tenantId, requester, idempotencyKey), where
 * requester is `user:<id>` or `ip:<address>`. The dedup claim
 * marks the key as taken; the kv entry holds the response returned to
 * repeats of the request.
 */
export const CREATE_REQUEST_DEDUP = defineKey({
  capability: 'dedup',
  module: 'user',
  name: 'create-request',
  version: 'v1',
});

export const CREATE_RESPONSE_KEY = defineKey({
  capability: 'kv',
  module: 'user',
  name: 'create-response',
  version: 'v1',
});

export const IDEMPOTENCY_TTL_SECONDS = 86_400; // 24 h

/**
 * Consumer dedup per event id: global(eventId). The event id is the outbox
 * event id (envelope `id`), unique across tenants.
 */
export const USER_EVENT_SEEN = defineKey({
  capability: 'dedup',
  module: 'user',
  name: 'event-seen',
  version: 'v1',
});

/** Self sign-ups per client address, across tenants: global(ip). */
export const SIGNUP_IP_RATE_LIMIT = defineKey({
  capability: 'ratelimit',
  module: 'user',
  name: 'signup-ip',
  version: 'v1',
});

/** Self sign-ups per tenant: forTenant(tenantId). */
export const SIGNUP_TENANT_RATE_LIMIT = defineKey({
  capability: 'ratelimit',
  module: 'user',
  name: 'signup-tenant',
  version: 'v1',
});

/** Search index and vector collection holding user profiles. */
export const USER_SEARCH_INDEX = 'users';
export const USER_VECTOR_COLLECTION = 'user-profile';
