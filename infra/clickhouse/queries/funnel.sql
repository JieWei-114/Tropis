-- Funnel: page.view → nav.click → user.login  (windowFunnel, 30-min window)
-- Table: logs.user_behavior (see ../init-tracking.sql)
-- Event names come from packages/shared TRACKING_EVENTS (docs/tracking-plan.md).
--
-- windowFunnel returns, per user, the deepest consecutive step reached
-- within the window. We funnel on anonymous_id so pre-login steps count.

SELECT
    level,
    count() AS users,
    round(100 * users / max(users) OVER (), 1) AS pct_of_step_1
FROM
(
    SELECT
        anonymous_id,
        windowFunnel(1800)( -- 30-minute window, in seconds
            toDateTime(timestamp),
            event_name = 'page.view',
            event_name = 'nav.click',
            event_name = 'user.login'
        ) AS level
    FROM logs.user_behavior
    WHERE timestamp >= now() - INTERVAL 30 DAY
    GROUP BY anonymous_id
)
WHERE level >= 1
GROUP BY level
ORDER BY level;
