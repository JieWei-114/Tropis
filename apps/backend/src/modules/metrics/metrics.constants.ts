// Metric names shared between the registry (metrics.module.ts) and the
// @InjectMetric(...) call sites, so a rename cannot silently desync them from
// the Prometheus rules in infra/prometheus/alerts.yml.
export const OUTBOX_ROWS_METRIC = 'tropis_outbox_rows';
export const OUTBOX_RELAY_LAST_POLL_METRIC =
  'tropis_outbox_relay_last_poll_timestamp_seconds';
export const TRACKING_DUPLICATES_METRIC =
  'tropis_tracking_duplicate_events_dropped_total';
