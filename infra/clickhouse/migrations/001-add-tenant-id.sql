-- Migration 001 — add tenant_id to the analytics and user-event tables.
--
-- Run: docker exec -i tropis_clickhouse clickhouse-client --multiquery \
--        < infra/clickhouse/migrations/001-add-tenant-id.sql
--
-- WHY A REBUILD AND NOT `ALTER TABLE ADD COLUMN`
-- Adding the column is trivial, but tenant_id has to be the FIRST key column
-- (see init-analytics.sql), and ClickHouse cannot change a MergeTree sort key
-- to add a new leading column in place. So each table is recreated with the
-- correct key, backfilled, and swapped in atomically with EXCHANGE TABLES.
--
-- Existing rows predate multi-tenancy and all belong to the default tenant,
-- so they are backfilled with 'default'.
--
-- Idempotent: re-running is a no-op once the tables already carry tenant_id
-- as their leading key, because the *_new tables are dropped at the end.

CREATE DATABASE IF NOT EXISTS logs;

-- ── logs.analytics_events ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS logs.analytics_events_new
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

INSERT INTO logs.analytics_events_new
    (tenant_id, event_id, event_type, user_id, payload, ts, ingested_at)
SELECT 'default', event_id, event_type, user_id, payload, ts, ingested_at
FROM logs.analytics_events;

EXCHANGE TABLES logs.analytics_events AND logs.analytics_events_new;
DROP TABLE IF EXISTS logs.analytics_events_new;

-- ── logs.user_events ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS logs.user_events_new
(
    tenant_id   LowCardinality(String) DEFAULT 'default',
    event_id    String,
    event_type  LowCardinality(String),
    user_id     String,
    email       String,
    ts          Int64,
    ingested_at DateTime DEFAULT now()
)
ENGINE = MergeTree()
ORDER BY (tenant_id, event_type, ts)
PARTITION BY toYYYYMM(toDateTime(ts / 1000));

INSERT INTO logs.user_events_new
    (tenant_id, event_id, event_type, user_id, email, ts, ingested_at)
SELECT 'default', event_id, event_type, user_id, email, ts, ingested_at
FROM logs.user_events;

EXCHANGE TABLES logs.user_events AND logs.user_events_new;
DROP TABLE IF EXISTS logs.user_events_new;

-- ── logs.analytics_minutely_agg + its materialized view ────────────────────
-- The view has to be dropped before the aggregate table is swapped: it writes
-- into that table, and its SELECT list must gain tenant_id at the same time.
DROP VIEW IF EXISTS logs.analytics_minutely;

CREATE TABLE IF NOT EXISTS logs.analytics_minutely_agg_new
(
    tenant_id    LowCardinality(String) DEFAULT 'default',
    window_start DateTime,
    event_type   LowCardinality(String),
    event_count  UInt64
)
ENGINE = SummingMergeTree(event_count)
ORDER BY (tenant_id, window_start, event_type)
PARTITION BY toYYYYMM(window_start);

INSERT INTO logs.analytics_minutely_agg_new
    (tenant_id, window_start, event_type, event_count)
SELECT 'default', window_start, event_type, event_count
FROM logs.analytics_minutely_agg;

EXCHANGE TABLES logs.analytics_minutely_agg AND logs.analytics_minutely_agg_new;
DROP TABLE IF EXISTS logs.analytics_minutely_agg_new;

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
