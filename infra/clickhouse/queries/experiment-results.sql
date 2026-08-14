-- A/B experiment results: conversion rate per variant.
-- Joins 'experiment.exposed' exposures against a conversion event
-- (default: 'user.login') for the same anonymous_id, converting only if the
-- conversion happened AFTER first exposure. See docs/tracking-plan.md →
-- Experiments. Table: logs.user_behavior (../init-tracking.sql)
--
-- Parameters to edit: experiment name ('new-onboarding') and the
-- conversion event name ('user.login').

WITH
    exposures AS
    (
        SELECT
            anonymous_id,
            JSONExtractString(props, 'variant') AS variant,
            min(timestamp)                      AS first_exposed_at
        FROM logs.user_behavior
        WHERE event_name = 'experiment.exposed'
          AND JSONExtractString(props, 'experiment') = 'new-onboarding'
        GROUP BY anonymous_id, variant
    ),
    conversions AS
    (
        SELECT anonymous_id, min(timestamp) AS converted_at
        FROM logs.user_behavior
        WHERE event_name = 'user.login'
        GROUP BY anonymous_id
    )
SELECT
    e.variant                                              AS variant,
    count()                                                AS exposed_users,
    countIf(c.converted_at >= e.first_exposed_at)          AS converted_users,
    round(100 * converted_users / exposed_users, 2)        AS conversion_pct
FROM exposures AS e
LEFT JOIN conversions AS c USING (anonymous_id)
GROUP BY variant
ORDER BY variant;
