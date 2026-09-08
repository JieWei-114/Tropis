# Tracking plan (event-tracking dictionary & governance)

The contract for every user-behavior tracking event this system emits.
Code source of truth: [`packages/shared/src/events/tracking-events.ts`](../packages/shared/src/events/tracking-events.ts)
(`TRACKING_EVENTS`). This doc is the human-readable registry and the rules.

Pipeline recap (details in [tech-decisions.md → Tracking](tech-decisions.md#tracking-user-behavior-instrumentation)):
SDK tracker (`packages/sdk/src/tracking`) → `POST /api/v1/track` → Pulsar
`tracking-events` → `tracking.processor.ts` → ClickHouse `logs.user_behavior`.
Analysis: [`infra/clickhouse/queries/`](../infra/clickhouse/queries/README.md),
CH-UI (:8124) or Metabase (:3200, `tools` profile).

## THE RULE

> **New events must be added to `packages/shared/src/events/tracking-events.ts`
> AND to this doc BEFORE any code emits them.** Treat event names like API
> contracts: **add-only**. Never rename an event in place — deprecate the old
> entry (mark it here, keep the constant) and add a new one. Renames silently
> fork history in ClickHouse and break every saved query and dashboard.

Frontend code must import names from the dictionary
(`TRACKING_EVENTS.NAV_CLICK.name`) — **no string literals** at `track()` call
sites. The only exceptions are inside the SDK itself (`page.view`,
`experiment.exposed`), which has no dependency on `@tropis/shared`; those names
are registered in the dictionary and must be kept in sync.

## Naming convention

`<object>.<action>` — dot-separated, lowercase, `snake_case` within a segment.
Use `<area>.<object>.<action>` only when the object alone is ambiguous.

- ✅ `page.view`, `nav.click`, `user.login`, `experiment.exposed`
- ❌ `NavClick`, `clicked_nav`, `nav-click`, `login`

This is the **tracking** namespace only. The analytics pipeline's
`AnalyticsEventType` enum (`page_view`, `button_click`, `api_call`, `error`,
`purchase`) is a separate backend/ClickHouse contract
(`apps/backend/.../analytics/schemas/event-log.schema.ts`) and keeps its
snake_case values — do not "unify" it.

## Base properties (auto-captured by the tracker)

Every event carries these — never duplicate them in `props`:

| Field                             | Meaning                                                    |
| --------------------------------- | ---------------------------------------------------------- |
| `eventId`                         | UUID per event                                             |
| `eventName`                       | Registered name from this plan                             |
| `anonymousId`                     | Device id, `localStorage` (`trk_anon_id`), survives logout |
| `userId`                          | Set after `tracker.identify()` on login; empty before      |
| `sessionId`                       | `sessionStorage`, 30-min sliding window                    |
| `page`                            | `location.pathname` at emit time                           |
| `referrer`, `userAgent`, `screen` | Browser context                                            |
| `timestamp`                       | Epoch ms, client clock                                     |

`props` is a free-form JSON object per event (schemas below); stored as a JSON
string in ClickHouse — query with `JSONExtractString(props, 'key')`.

## Event registry

| Name                 | When fired                                                                        | Props                                                                                   | Owner    |
| -------------------- | --------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- | -------- |
| `page.view`          | Auto on every SPA route change (`<PageTracker />` → `tracker.page`)               | `{ path: string }`                                                                      | frontend |
| `nav.click`          | Sidebar (or mobile top-bar) nav link clicked (`App.tsx`)                          | `{ to: string; label: string }`                                                         | frontend |
| `user.login`         | Successful sign-in, after `tracker.identify` (`LoginForm`, both modes)            | `{ mode: 'login' \| 'register' }`                                                       | frontend |
| `user.register`      | Account created via the register form (`LoginForm`)                               | `{ email: string }`                                                                     | frontend |
| `button.click`       | Generic UI button click (currently the FireEventPanel demo buttons)               | `{ label: string; eventType: string }`                                                  | frontend |
| `experiment.exposed` | First bucketing of a user into an experiment variant (`tracker.exposeExperiment`) | `{ experiment: string; variant: string }`                                               | shared   |
| `perf.web_vitals`    | A Core Web Vitals metric settled (`reportWebVitals` in `src/lib/webVitals.ts`)    | `{ metric: string; value: number; rating: string; id: string; navigationType: string }` | frontend |

### Deprecated / migrated names

Emitted before 2026-08; old rows may still exist in ClickHouse — historical
queries spanning the migration should `IN` both names.

| Old name                                                        | New name        |
| --------------------------------------------------------------- | --------------- |
| `page_view` (tracking event only — analytics enum unchanged)    | `page.view`     |
| `nav_click`                                                     | `nav.click`     |
| `login`                                                         | `user.login`    |
| `user_registered`                                               | `user.register` |
| `button_click` (tracking event only — analytics enum unchanged) | `button.click`  |

## Experiments (A/B tests)

Feature flags (`apps/backend/src/common/feature-flags/`) decide _what a user
sees_; tracking measures _what happened_. Convention when a flag splits users:

1. **Emit an exposure event** the moment the user actually experiences the
   variant (not at flag evaluation in the background):
   `tracker.exposeExperiment('new-onboarding', 'variant-b')` — this wraps
   `track('experiment.exposed', { experiment, variant })`. The event is
   registered in the shared dictionary as `TRACKING_EVENTS.EXPERIMENT_EXPOSED`.
2. **Experiment names** follow the flag key (kebab-case); **variants** are
   `control` / `variant-a` / `variant-b` (or descriptive kebab-case).
3. **One exposure per user per experiment** is what analysis assumes; the
   query dedupes with `min(timestamp)` per `anonymous_id`, so emitting on
   every render is tolerated but wasteful — prefer emitting once per session.
4. **Analysis** = ClickHouse join of exposures vs a conversion event, counting
   only conversions after first exposure:
   [`infra/clickhouse/queries/experiment-results.sql`](../infra/clickhouse/queries/experiment-results.sql)
   (conversion rate per variant; edit the experiment name and conversion event
   at the top).

## Adding a new event — checklist

1. Add the entry to `TRACKING_EVENTS` in
   `packages/shared/src/events/tracking-events.ts` (name, description, props
   schema in the doc comment).
2. Add a row to the registry table above (name / when fired / props / owner).
3. Only then emit it: `tracker.track(TRACKING_EVENTS.MY_EVENT.name, props)`.
4. No backend change needed — ingest is schema-agnostic (`event_name` is a
   `LowCardinality(String)` in `logs.user_behavior`).
