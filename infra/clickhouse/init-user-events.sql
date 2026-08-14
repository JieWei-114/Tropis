-- docker exec -i tropis_clickhouse clickhouse-client < infra/clickhouse/init-user-events.sql

CREATE DATABASE IF NOT EXISTS logs;

CREATE TABLE IF NOT EXISTS logs.user_events
(
    event_id    String,
    event_type  LowCardinality(String),
    user_id     String,
    email       String,
    ts          Int64,
    ingested_at DateTime DEFAULT now()
)
ENGINE = MergeTree()
ORDER BY (event_type, ts)
PARTITION BY toYYYYMM(toDateTime(ts / 1000));
