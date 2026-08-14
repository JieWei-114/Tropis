# ClickHouse analytics query reference

Reference SQL against the tracking table `logs.user_behavior`
(schema: [`../init-tracking.sql`](../init-tracking.sql)). Event names are the
registered tracking names from `packages/shared/src/events/tracking-events.ts`
— see [docs/tracking-plan.md](../../../docs/tracking-plan.md).

Run any file against the local container:

```bash
docker exec -i tropis_clickhouse clickhouse-client < infra/clickhouse/queries/funnel.sql
```

Or paste into CH-UI (http://localhost:8124, `tools` profile) / Metabase
(http://localhost:3200, `tools` profile).

| File                                               | What it answers                                                                                             |
| -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| [`funnel.sql`](funnel.sql)                         | Conversion funnel `page.view → nav.click → user.login` via `windowFunnel` (30-min window, per anonymous_id) |
| [`retention.sql`](retention.sql)                   | 7-day retention of the cohort active 7 days ago, via `retention()`                                          |
| [`daily-actives.sql`](daily-actives.sql)           | DAU (anonymous + identified), sessions, and event volume per day                                            |
| [`top-paths.sql`](top-paths.sql)                   | Most common ordered page sequences per session                                                              |
| [`experiment-results.sql`](experiment-results.sql) | A/B test conversion rate per variant (`experiment.exposed` joined to a conversion event)                    |

Notes:

- The table is small-scale dev data; none of these need sampling or
  `max_execution_time` guards locally.
- Funnels/retention key on `anonymous_id` so pre-login activity counts;
  switch to `user_id` (filter `user_id != ''`) for signed-in-only analysis.
- `props` is a JSON string — extract fields with `JSONExtractString(props, 'key')`.
