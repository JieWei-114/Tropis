-- 7-day retention: of users first-seen active on day 0, how many came back
-- on each of the following 7 days. Uses the retention() aggregate.
-- Table: logs.user_behavior (see ../init-tracking.sql)
--
-- "Active" = any tracking event. Cohort day 0 is 7 days ago; change the
-- anchor date to shift the cohort.

-- TENANT SCOPE: set this to the tenant you are analysing. logs.user_behavior
-- is multi-tenant and tenant_id is its leading key column, so leaving the
-- filter out aggregates every tenant together (and reads the whole table).
SET param_tenant_id = 'default';

WITH toDate(now() - INTERVAL 7 DAY) AS day0
SELECT
    sum(r[1]) AS day_0,
    sum(r[2]) AS day_1,
    sum(r[3]) AS day_2,
    sum(r[4]) AS day_3,
    sum(r[5]) AS day_4,
    sum(r[6]) AS day_5,
    sum(r[7]) AS day_6,
    sum(r[8]) AS day_7,
    round(100 * day_7 / day_0, 1) AS d7_retention_pct
FROM
(
    SELECT
        anonymous_id,
        retention(
            toDate(timestamp) = day0,
            toDate(timestamp) = day0 + 1,
            toDate(timestamp) = day0 + 2,
            toDate(timestamp) = day0 + 3,
            toDate(timestamp) = day0 + 4,
            toDate(timestamp) = day0 + 5,
            toDate(timestamp) = day0 + 6,
            toDate(timestamp) = day0 + 7
        ) AS r
    FROM logs.user_behavior
    WHERE tenant_id = {tenant_id:String}
      AND toDate(timestamp) BETWEEN day0 AND day0 + 7
    GROUP BY anonymous_id
);
