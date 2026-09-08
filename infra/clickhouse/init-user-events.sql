-- docker exec -i tropis_clickhouse clickhouse-client < infra/clickhouse/init-user-events.sql
--
-- See the note in init-analytics.sql on why tenant_id leads the ORDER BY.

CREATE DATABASE IF NOT EXISTS logs;

CREATE TABLE IF NOT EXISTS logs.user_events
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
