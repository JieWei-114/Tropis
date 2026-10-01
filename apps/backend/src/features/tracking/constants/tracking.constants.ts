import { EVENT_TYPES } from '@tropis/shared';
import { defineKey } from '../../../common/keyspace';

/** Logical topic carrying raw user-behavior tracking batches. */
export const TRACKING_TOPIC = 'tracking-events';

/** Envelope type of one published tracking batch. */
export const TRACKING_BATCH_EVENT_TYPE = EVENT_TYPES.TRACKING_BATCH_RECEIVED;

/** Authorization resource the insights read is checked against. */
export const TRACKING_INSIGHTS_RESOURCE = 'analytics';

/** Subscription used by the in-process ClickHouse sink. */
export const TRACKING_SUBSCRIPTION = 'tracking-processor-sub';

/** Maximum events accepted per ingest batch (POST /api/v1/track). */
export const TRACKING_MAX_BATCH = 100;

/** Maximum length of free-text string fields on an ingested event. */
export const TRACKING_MAX_FIELD_LEN = 1024;

/** OLAP destination table. */
export const TRACKING_TABLE = 'logs.user_behavior';

/** Insights defaults. */
export const TRACKING_INSIGHTS_DEFAULT_DAYS = 7;
export const TRACKING_TOP_PAGES_LIMIT = 10;
export const TRACKING_RECENT_LIMIT = 20;

/**
 * Idempotency marker per ingested event: forTenant(tenantId, eventId).
 *
 * Every event carries a client-generated `eventId` UUID. `logs.user_behavior`
 * is a plain MergeTree with no deduplication, so without this marker a
 * retried batch — the normal case, since `navigator.sendBeacon` and the SDK
 * both retry on network failure — is counted twice and inflates every
 * aggregate built on it.
 */
export const TRACKING_EVENT_SEEN = defineKey({
  capability: 'dedup',
  module: 'tracking',
  name: 'event-seen',
  version: 'v1',
});

/**
 * Consumer write marker per event: forTenant(tenantId, eventId). Separate
 * from TRACKING_EVENT_SEEN, which ingest already claimed; this one stops a
 * broker redelivery of a written batch from being inserted again.
 */
export const TRACKING_EVENT_WRITTEN = defineKey({
  capability: 'dedup',
  module: 'tracking',
  name: 'event-written',
  version: 'v1',
});

/**
 * Marker TTL. Long enough to cover client retry windows and a broker outage,
 * short enough that the key space stays bounded at ingest volume.
 */
export const TRACKING_SEEN_TTL_SECONDS = 24 * 60 * 60;

/**
 * TTL of the claim held while a batch is being published; extended to
 * TRACKING_SEEN_TTL_SECONDS once the publish succeeded and released when it
 * failed, so a crashed or failed publish never marks an event as seen.
 */
export const TRACKING_CLAIM_TTL_SECONDS = 30;

/** Counter of events the ingest dedup claim rejected. */
export const TRACKING_DUPLICATES_METRIC =
  'tropis_tracking_duplicate_events_dropped_total';
