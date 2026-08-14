-- Mounted as /docker-entrypoint-initdb.d/04-audit.sql via infra/docker/docker-compose.yml.
-- Manual run on an existing cluster:
--   docker exec -i tropis_clickhouse clickhouse-client < infra/clickhouse/init-audit.sql
--
-- Security audit trail for sensitive/mutating actions.
-- Fed by: AuditInterceptor (apps/backend/src/common/interceptors/audit.interceptor.ts)
--         → AuditLogService (apps/backend/src/modules/audit/) fire-and-forget insert.

CREATE DATABASE IF NOT EXISTS logs;

CREATE TABLE IF NOT EXISTS logs.audit_log
(
    timestamp     DateTime64(3),
    action        LowCardinality(String),      -- e.g. 'user.update', 'auth.login'
    actor_user_id String,                       -- JWT sub, empty if unauthenticated
    tenant_id     LowCardinality(String) DEFAULT 'default',
    resource      String,                       -- 'POST /api/auth/login' or 'UserService.Update'
    transport     LowCardinality(String),      -- 'http' | 'rpc' | 'ws'
    outcome       LowCardinality(String),      -- 'success' | 'error'
    error         String DEFAULT '',            -- error name/message on failure
    trace_id      String                        -- correlation/request id
)
ENGINE = MergeTree()
ORDER BY (tenant_id, action, timestamp)
PARTITION BY toYYYYMM(timestamp)
TTL toDateTime(timestamp) + INTERVAL 2 YEAR;
