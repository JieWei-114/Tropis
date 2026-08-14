-- Run once before starting the backend or Flink job.
-- docker exec -i tropis_clickhouse clickhouse-client < infra/clickhouse/init-analytics.sql

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

-- Aggregate table backing the materialized view
CREATE TABLE IF NOT EXISTS logs.analytics_minutely_agg
(
    window_start DateTime,
    event_type   LowCardinality(String),
    event_count  UInt64
)
ENGINE = SummingMergeTree(event_count)
ORDER BY (window_start, event_type)
PARTITION BY toYYYYMM(window_start);

-- Materialized view that populates the aggregate on insert
CREATE MATERIALIZED VIEW IF NOT EXISTS logs.analytics_minutely
TO logs.analytics_minutely_agg
AS
SELECT
    toStartOfMinute(toDateTime(ts / 1000)) AS window_start,
    event_type,
    count()                                AS event_count
FROM logs.analytics_events
GROUP BY window_start, event_type;
