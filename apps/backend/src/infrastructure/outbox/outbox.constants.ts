import { defineKey } from '../../common/keyspace';
import type { JobQueueDefinition } from '../jobs/jobs.registry';

/**
 * One lease per aggregate: global(aggregateId). The relay publishes an
 * aggregate's rows only while it holds that aggregate's lease, so any number
 * of relay instances run at once and each aggregate's events still leave in
 * order.
 */
export const OUTBOX_AGGREGATE_LEASE = defineKey({
  capability: 'lock',
  module: 'outbox',
  name: 'aggregate',
  version: 'v1',
});

/**
 * Longest a single publish may take before the relay counts it as failed.
 * The broker may still deliver it later; consumers dedup on the event id.
 */
export const OUTBOX_PUBLISH_TIMEOUT_MS = 30_000;

/**
 * Lease length. Above the publish timeout, and renewed before every publish
 * and every LEASE_RENEW_INTERVAL_MS while one is in flight, so a slow publish
 * never lets another instance take the aggregate mid-publish.
 */
export const AGGREGATE_LEASE_TTL_MS = 45_000;

export const LEASE_RENEW_INTERVAL_MS = 5_000;

/** Pause between the end of one relay poll and the start of the next. */
export const OUTBOX_POLL_INTERVAL_MS = 5_000;

/** Pause before the next poll when the last one relayed a full batch. */
export const OUTBOX_REPOLL_DELAY_MS = 10;

/** How often each relay instance refreshes tropis_outbox_backlog_rows. */
export const BACKLOG_GAUGE_INTERVAL_MS = 60_000;

/** Aggregates a relay instance relays per poll. */
export const AGGREGATES_PER_POLL = 50;

/**
 * Due aggregates read per poll. Wider than a batch and taken in random order
 * when it overflows one, so concurrent instances spread over the backlog
 * instead of contending for the same oldest aggregates.
 */
export const CANDIDATES_PER_POLL = 200;

/** Rows of one aggregate published per poll before it yields. */
export const ROWS_PER_AGGREGATE = 20;

/** Publish attempts before a row moves to the terminal DEAD state. */
export const MAX_ATTEMPTS = 5;

/** Base for the exponential retry backoff: base * 2^(attempts - 1). */
export const RETRY_BACKOFF_BASE_MS = 5_000;

/** Job name of the once-a-minute sweep (dead-lettering, DEAD backlog alert). */
export const OUTBOX_SWEEP_JOB = 'outbox-sweep';

export const QUEUE_OUTBOX_MAINTENANCE = 'outbox-maintenance';

/** The sweep queue: one attempt, the next minute's job is the retry. */
export const OUTBOX_MAINTENANCE_QUEUE: JobQueueDefinition = {
  name: QUEUE_OUTBOX_MAINTENANCE,
  defaults: { attempts: 1, removeOnComplete: 10, removeOnFail: 50 },
  deadLetter: false,
};

/** `source` of the events the relay publishes. */
export const OUTBOX_EVENT_SOURCE = '/tropis/backend/outbox';

/** Gauge of the open backlog by status, read by infra/prometheus/alerts.yml. */
export const OUTBOX_BACKLOG_METRIC = 'tropis_outbox_backlog_rows';

/** Events published to the broker (rows that became DISPATCHED). */
export const OUTBOX_PUBLISHED_METRIC = 'tropis_outbox_published_total';

/** Failed publish attempts, by what the row became (`failed` or `dead`). */
export const OUTBOX_PUBLISH_FAILED_METRIC =
  'tropis_outbox_publish_failed_total';

/** Days a DISPATCHED or SKIPPED row is kept before MongoDB deletes it. */
export const DEFAULT_OUTBOX_RETENTION_DAYS = 7;

/** Heartbeat gauge of the last completed relay poll. */
export const OUTBOX_RELAY_LAST_POLL_METRIC =
  'tropis_outbox_relay_last_poll_timestamp_seconds';
