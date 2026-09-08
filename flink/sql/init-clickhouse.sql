-- Destination table for the Flink job (flink/src/.../PulsarToClickHouseJob.java).
-- Run once before submitting the job:
--   docker exec -i tropis_clickhouse clickhouse-client < flink/sql/init-clickhouse.sql
--
-- This is deliberately a SEPARATE table from logs.analytics_events, which the
-- NestJS AnalyticsProcessor writes and the console reads. Both consumers
-- receive every message from the topic (different Pulsar subscriptions) and
-- MergeTree does not deduplicate, so one shared table would double every
-- count the dashboard shows while the job runs. Keeping them apart makes the
-- job safe to submit at any time; query both to compare the in-process
-- pipeline against the streaming one.
--
-- The schema mirrors infra/clickhouse/init-analytics.sql, including tenant_id
-- as the leading key column — see the note there on why that ordering matters.

CREATE DATABASE IF NOT EXISTS logs;

CREATE TABLE IF NOT EXISTS logs.analytics_events_flink
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
