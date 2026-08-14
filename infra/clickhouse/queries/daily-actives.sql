-- Daily actives: unique visitors (anonymous_id) and unique signed-in users
-- per day, last 30 days. Table: logs.user_behavior (see ../init-tracking.sql)

SELECT
    toDate(timestamp)                          AS day,
    uniq(anonymous_id)                         AS dau_anon,
    uniqIf(user_id, user_id != '')             AS dau_identified,
    count()                                    AS events,
    uniq(session_id)                           AS sessions
FROM logs.user_behavior
WHERE timestamp >= now() - INTERVAL 30 DAY
GROUP BY day
ORDER BY day ASC;
