-- Run once before submitting the Flink job.
-- docker exec -i tropis_clickhouse clickhouse-client < flink/sql/init-clickhouse.sql
--
-- Note: infra/clickhouse/init-analytics.sql creates the same table for the NestJS
-- AnalyticsProcessor. Both the NestJS processor and the Flink job write to the same
-- table using different Pulsar subscription names — they each receive every message.

CREATE DATABASE IF NOT EXISTS logs;

CREATE TABLE IF NOT EXISTS logs.analytics_events
(
    event_id    String,
    event_type  LowCardinality(String),
    user_id     String,
    payload     String,
    ts          Int64,
    ingested_at DateTime DEFAULT now()
)
ENGINE = MergeTree()
ORDER BY (event_type, ts)
PARTITION BY toYYYYMM(toDateTime(ts / 1000));
