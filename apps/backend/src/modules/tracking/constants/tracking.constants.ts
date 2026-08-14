/** Pulsar topic carrying raw user-behavior tracking batches. */
export const TRACKING_TOPIC = 'persistent://public/default/tracking-events';

/** Subscription used by the in-process ClickHouse sink. */
export const TRACKING_SUBSCRIPTION = 'tracking-processor-sub';

/** Maximum events accepted per ingest batch (POST /api/v1/track). */
export const TRACKING_MAX_BATCH = 100;

/** Maximum length of free-text string fields on an ingested event. */
export const TRACKING_MAX_FIELD_LEN = 1024;

/** ClickHouse destination table. */
export const TRACKING_TABLE = 'logs.user_behavior';

/** Insights defaults. */
export const TRACKING_INSIGHTS_DEFAULT_DAYS = 7;
export const TRACKING_TOP_PAGES_LIMIT = 10;
export const TRACKING_RECENT_LIMIT = 20;
