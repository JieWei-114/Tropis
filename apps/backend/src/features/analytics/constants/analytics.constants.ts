import { EVENT_TYPES } from '@tropis/shared';
import { defineKey } from '../../../common/keyspace';

/** Logical topic; the Flink job (services/flink) reads it too. */
export const ANALYTICS_TOPIC = 'analytics-events';
export const ANALYTICS_SUBSCRIPTION = 'analytics-processor-sub';

/** CloudEvents type of every analytics event; the analytics type is in `data.eventType`. */
export const ANALYTICS_EVENT_RECORDED = EVENT_TYPES.ANALYTICS_EVENT_RECORDED;

/** Authorization resource of this feature (infra/opa/authz.rego). */
export const ANALYTICS_RESOURCE = 'analytics';

/** Cached 24 h stats per tenant: forTenant(tenantId). */
export const ANALYTICS_STATS_CACHE = defineKey({
  capability: 'cache',
  module: 'analytics',
  name: 'stats',
  version: 'v1',
});
export const ANALYTICS_CACHE_TTL_SEC = 30;

/**
 * Consumer dedup per domain event id: global(eventId). OLAP MergeTree tables
 * do not deduplicate, so a redelivery would otherwise be counted twice.
 */
export const ANALYTICS_EVENT_SEEN = defineKey({
  capability: 'dedup',
  module: 'analytics',
  name: 'event-seen',
  version: 'v1',
});

export const ANALYTICS_EVENTS_TABLE = 'logs.analytics_events';
export const ANALYTICS_MINUTELY_TABLE = 'logs.analytics_minutely';

/**
 * Roles whose sockets receive the live analytics feed: the roles
 * infra/opa/authz.rego grants `analytics:read`. Self-registered members hold
 * none of them, so the feed never reaches them.
 */
export const ANALYTICS_LIVE_FEED_ROLES = ['admin', 'editor', 'viewer'] as const;
