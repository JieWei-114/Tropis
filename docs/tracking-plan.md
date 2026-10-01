# Tracking plan (event-tracking dictionary & governance)

The contract for every user-behavior tracking event this system emits.
Code source of truth: `packages/shared/src/events/tracking-events.ts`
(`TRACKING_EVENTS`, exported from `@tropis/shared`). This doc is the
human-readable registry and the rules.

Pipeline recap (details in [tech-decisions.md → Tracking](tech-decisions.md#tracking-user-behavior-instrumentation)):
SDK tracker (`packages/sdk/src/tracking`) → `POST /api/v1/track` → event bus
topic `tracking-events` (messaging port) →
`features/tracking/processors/tracking.processor.ts` (worker role) →
ClickHouse `logs.user_behavior` (schema: `infra/clickhouse/init-tracking.sql`).
Analysis: `infra/clickhouse/queries/` (see its `README.md`),
CH-UI (:8124) or Metabase (:3200), both in the `tools` Docker Compose profile.

## THE RULE

> **New events must be added to `packages/shared/src/events/tracking-events.ts`
> AND to this doc BEFORE any code emits them.** Treat event names like API
> contracts: **add-only**. Never rename an event in place — deprecate the old
> entry (mark it here, keep the constant) and add a new one. Renames silently
> fork history in ClickHouse and break every saved query and dashboard.

Frontend code must import names from the dictionary
(`TRACKING_EVENTS.NAV_CLICK.name`) — **no string literals** at `track()` call
sites, because a typo in a literal creates a second event name and splits
that event's data across two names in ClickHouse. No lint rule enforces this;
it is checked in review. The only exceptions are inside the SDK itself (`page.view` in
`tracker.page()`, `experiment.exposed` in `tracker.exposeExperiment()`), which
has no dependency on `@tropis/shared`; those names are registered in the
dictionary and must be kept in sync.

## Naming convention

`<object>.<action>` — dot-separated, lowercase, `snake_case` within a segment.
Use `<area>.<object>.<action>` only when the object alone is ambiguous.

- Good: `page.view`, `nav.click`, `user.login`, `experiment.exposed`, `perf.web_vitals`
- Bad: `NavClick`, `clicked_nav`, `nav-click`, `login`

This is the **tracking** namespace only. The analytics pipeline's
`AnalyticsEventType` (`page_view`, `button_click`, `api_call`, `error`,
`purchase`; `ANALYTICS_EVENT_TYPES` in `packages/shared/src/events/event-types.ts`,
the one definition the backend and helm both import) is a
separate backend/ClickHouse contract and keeps its snake_case values — do not
"unify" it.

## Base properties (auto-captured by the tracker)

Every event carries these — never duplicate them in `props`:

| Field                             | Meaning                                                                                                                                                                                                                        |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `eventId`                         | UUID per event; the backend drops a repeated `eventId` (per tenant) for 24 h, so retries don't double-count                                                                                                                    |
| `eventName`                       | Registered name from this plan (max 128 chars)                                                                                                                                                                                 |
| `anonymousId`                     | Device id, `localStorage` (`trk_anon_id`), survives logout                                                                                                                                                                     |
| `userId`                          | Set after `tracker.identify()` on login; empty before. helm (the console) passes the login email, and the DTO caps `userId` at 64 characters (`track-event.dto.ts`), so an email longer than 64 fails the whole batch with 400 |
| `sessionId`                       | `sessionStorage` (`trk_session`), 30-min sliding window                                                                                                                                                                        |
| `page`                            | `location.pathname` at emit time                                                                                                                                                                                               |
| `referrer`, `userAgent`, `screen` | Browser context (`screen` is `<width>x<height>`)                                                                                                                                                                               |
| `timestamp`                       | Epoch ms, client clock (stored as-is in ClickHouse)                                                                                                                                                                            |

`tenant_id` is added server-side at ingest (`TrackingService.ingest`) from
the request's tenant: `X-Tenant-ID`, or `?tenant=` for `navigator.sendBeacon`
(the tracker's `tenantId` option; helm sets it from `VITE_TENANT_ID`). A batch
that names no tenant is rejected with `400 TENANT_REQUIRED` before anything is
published. Rules: [api-conventions.md](api-conventions.md#tenant).

`props` is a free-form JSON object per event (schemas below); stored as a JSON
string in ClickHouse — query with `JSONExtractString(props, 'key')`.

The tracker batches events (flush at 10 events, every 5 s, and on
`visibilitychange:hidden` / `pagehide` via `navigator.sendBeacon`); the ingest
endpoint accepts at most 100 events per batch and answers `202` immediately.

## Event registry

All frontend call sites are in `apps/frontend/helm/src/`.

| Name                 | When fired                                                                                   | Props                                                                                   | Owner    |
| -------------------- | -------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- | -------- |
| `page.view`          | Auto on every SPA route change (`<PageTracker />` in `app/PageTracker.tsx` → `tracker.page`) | `{ path: string }`                                                                      | frontend |
| `nav.click`          | Sidebar or mobile top-bar nav link clicked (`app/App.tsx`)                                   | `{ to: string; label: string }`                                                         | frontend |
| `user.login`         | Successful sign-in, right after `tracker.identify` (`LoginForm`, both modes)                 | `{ mode: 'login' \| 'register' }`                                                       | frontend |
| `user.register`      | Account created via the register form, before auto-login (`LoginForm`)                       | `{ email: string }`                                                                     | frontend |
| `button.click`       | Generic UI button click (the `FireEventPanel` demo buttons)                                  | `{ label: string; eventType: string }`                                                  | frontend |
| `experiment.exposed` | User exposed to an experiment variant (`tracker.exposeExperiment`)                           | `{ experiment: string; variant: string }`                                               | shared   |
| `perf.web_vitals`    | A Core Web Vitals metric settled (`reportWebVitals` in `lib/webVitals.ts`)                   | `{ metric: string; value: number; rating: string; id: string; navigationType: string }` | frontend |

`perf.web_vitals` sends `value` as `Math.round(metric.value)`
(`lib/webVitals.ts`), so CLS, a fraction below 1, always arrives as `0`; the
millisecond metrics are unaffected.

## Experiments (A/B tests)

The product decides _what a user sees_ (the backend has no feature-flag
service); tracking measures _what happened_. Convention when an experiment
splits users:

1. **Emit an exposure event** the moment the user actually experiences the
   variant (not when the variant is chosen in the background):
   `tracker.exposeExperiment('new-onboarding', 'variant-b')` — this enqueues
   `experiment.exposed` with `{ experiment, variant }`. The event is
   registered in the shared dictionary as `TRACKING_EVENTS.EXPERIMENT_EXPOSED`.
2. **Experiment names** are kebab-case; **variants** are
   `control` / `variant-a` / `variant-b` (or descriptive kebab-case).
3. **One exposure per user per experiment** is what analysis assumes; the
   query dedupes with `min(timestamp)` per `anonymous_id`, so emitting on
   every render is tolerated but wasteful — prefer emitting once per session.
4. **Analysis** = ClickHouse join of exposures vs a conversion event, counting
   only conversions after first exposure:
   `infra/clickhouse/queries/experiment-results.sql`
   (conversion rate per variant). Only the tenant is a parameter
   (`SET param_tenant_id` at the top); the experiment name
   (`'new-onboarding'`) and the conversion event (`'user.login'`) are literals
   inside the `exposures` and `conversions` CTEs — edit them there.

## Adding a new event — checklist

1. Add the entry to `TRACKING_EVENTS` in
   `packages/shared/src/events/tracking-events.ts` (name, description, props
   schema in the doc comment).
2. Add a row to the registry table above (name / when fired / props / owner).
3. Only then emit it: `tracker.track(TRACKING_EVENTS.MY_EVENT.name, props)`.
4. No backend change needed — ingest is schema-agnostic (`event_name` is a
   `LowCardinality(String)` in `logs.user_behavior`).
