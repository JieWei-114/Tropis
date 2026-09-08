-- User-behavior tracking (product analytics instrumentation) events.
-- Fed by: SDK tracker → POST /api/v1/track → Pulsar "tracking-events"
--         → TrackingProcessor (apps/backend/.../modules/tracking/processors/)
-- Run once before starting the backend:
-- docker exec -i tropis_clickhouse clickhouse-client < infra/clickhouse/init-tracking.sql

CREATE DATABASE IF NOT EXISTS logs;

CREATE TABLE IF NOT EXISTS logs.user_behavior
(
    event_id     UUID,
    event_name   LowCardinality(String),
    anonymous_id String,
    user_id      String,
    session_id   String,
    tenant_id    LowCardinality(String) DEFAULT 'default',
    page         String,
    referrer     String,
    user_agent   String,
    screen       String,
    props        String, -- JSON
    timestamp    DateTime64(3)
)
ENGINE = MergeTree()
ORDER BY (tenant_id, event_name, timestamp)
PARTITION BY toYYYYMM(timestamp);
