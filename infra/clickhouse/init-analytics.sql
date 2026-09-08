-- Run once before starting the backend or Flink job.
-- docker exec -i tropis_clickhouse clickhouse-client < infra/clickhouse/init-analytics.sql
--
-- tenant_id leads every ORDER BY: these tables are read exclusively through
-- per-tenant queries, so it is the most selective prefix, and having it in the
-- primary key is what lets ClickHouse skip other tenants' granules instead of
-- scanning them and filtering. It also makes a missing WHERE clause a
-- performance problem rather than a data leak waiting to happen.

CREATE DATABASE IF NOT EXISTS logs;

CREATE TABLE IF NOT EXISTS logs.analytics_events
(
    tenant_id   LowCardinality(String) DEFAULT 'default',
    event_id    String,
    event_type  LowCardinality(String),
    user_id     String,
    payload     String,
    ts          Int64,
    ingested_at DateTime DEFAULT now()
)
ENGINE = MergeTree()
ORDER BY (tenant_id, event_type, ts)
PARTITION BY toYYYYMM(toDateTime(ts / 1000));

-- Aggregate table backing the materialized view
CREATE TABLE IF NOT EXISTS logs.analytics_minutely_agg
(
    tenant_id    LowCardinality(String) DEFAULT 'default',
    window_start DateTime,
    event_type   LowCardinality(String),
    event_count  UInt64
)
ENGINE = SummingMergeTree(event_count)
ORDER BY (tenant_id, window_start, event_type)
PARTITION BY toYYYYMM(window_start);

-- Materialized view that populates the aggregate on insert.
-- tenant_id must be in the GROUP BY, otherwise minutes would be summed across
-- tenants and every tenant would see the whole cluster's traffic.
CREATE MATERIALIZED VIEW IF NOT EXISTS logs.analytics_minutely
TO logs.analytics_minutely_agg
AS
SELECT
    tenant_id,
    toStartOfMinute(toDateTime(ts / 1000)) AS window_start,
    event_type,
    count()                                AS event_count
FROM logs.analytics_events
GROUP BY tenant_id, window_start, event_type;
