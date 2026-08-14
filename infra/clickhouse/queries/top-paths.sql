-- Top navigation paths: the ordered sequence of pages viewed per session,
-- ranked by how many sessions followed that exact sequence (last 30 days).
-- Table: logs.user_behavior (see ../init-tracking.sql)
--
-- Only 'page.view' events; sequences capped at the first 10 pages to keep
-- cardinality sane. groupArray preserves ORDER BY inside the subquery.

SELECT
    arrayStringConcat(path_seq, ' → ') AS path,
    count()                            AS sessions
FROM
(
    SELECT
        session_id,
        arraySlice(groupArray(page), 1, 10) AS path_seq
    FROM
    (
        SELECT session_id, page, timestamp
        FROM logs.user_behavior
        WHERE event_name = 'page.view'
          AND timestamp >= now() - INTERVAL 30 DAY
        ORDER BY session_id, timestamp
    )
    GROUP BY session_id
)
GROUP BY path
ORDER BY sessions DESC
LIMIT 20;
