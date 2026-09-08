-- Daily actives: unique visitors (anonymous_id) and unique signed-in users
-- per day, last 30 days. Table: logs.user_behavior (see ../init-tracking.sql)

-- TENANT SCOPE: set this to the tenant you are analysing. logs.user_behavior
-- is multi-tenant and tenant_id is its leading key column, so leaving the
-- filter out aggregates every tenant together (and reads the whole table).
SET param_tenant_id = 'default';

SELECT
    toDate(timestamp)                          AS day,
    uniq(anonymous_id)                         AS dau_anon,
    uniqIf(user_id, user_id != '')             AS dau_identified,
    count()                                    AS events,
    uniq(session_id)                           AS sessions
FROM logs.user_behavior
WHERE tenant_id = {tenant_id:String}
  AND timestamp >= now() - INTERVAL 30 DAY
GROUP BY day
ORDER BY day ASC;
