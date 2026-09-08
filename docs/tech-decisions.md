# Technology Decisions

The core document. Every datastore/broker/tool in this stack exists for a specific job. This page tells you **what each one is, when to use it, when NOT to, and where it lives in the code** — so you never guess.

Golden rule: **pick the tool by access pattern, not by familiarity.** If two tools could work, use the decision tables below.

---

## Redis vs Aerospike

|               | Redis                                                                                                                                                     | Aerospike                                                                                               |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| What          | In-memory data structure store                                                                                                                            | Distributed, flash-optimized KV store                                                                   |
| Use for       | General caching, BullMQ job queues, token/JWT blacklists, rate-limit counters, event dedup (SET NX), pub/sub glue                                         | Ultra-low-latency, high-concurrency KV at scale: session store, per-user hot state, millions of ops/sec |
| Don't use for | Datasets larger than RAM, strict sub-ms p99 at very high concurrency → Aerospike                                                                          | Rich data structures (lists/sorted sets), queues, Lua-style ops → Redis                                 |
| In code       | `src/infrastructure/redis/redis.module.ts`; consumed by `src/infrastructure/queue/` (BullMQ), user query cache, event dedup in `modules/user/processors/` | `src/infrastructure/aerospike/` — `session.service.ts` stores auth sessions                             |

Decision: **default to Redis.** Reach for Aerospike only when the workload is pure KV, latency-critical, and expected to outgrow a single Redis node's memory (sessions are the canonical example here).

## MongoDB vs PostgreSQL

|               | MongoDB                                                                                                                             | PostgreSQL                                                                                                                                                                   |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| What          | Document store                                                                                                                      | Relational ACID database                                                                                                                                                     |
| Use for       | Flexible/unstructured schemas, event store (append-only `modules/user/event-store/`), outbox collection, documents that evolve fast | Anything relational or money-adjacent: orders, payments, ledgers, invariants enforced by constraints/transactions across tables; **pgvector** for embeddings/semantic search |
| Don't use for | Multi-row financial invariants, cross-entity joins, strict schemas → PostgreSQL                                                     | High-churn schemaless payloads, event logs → MongoDB                                                                                                                         |
| In code       | Mongoose schemas in each module's `schemas/`; the outbox collection (`src/infrastructure/outbox/`)                                  | `src/infrastructure/postgres/` (TypeORM + pgvector); migrations in `apps/backend/migrations/` (node-pg-migrate)                                                              |

Decision: **if losing or double-counting a row costs money, it goes in PostgreSQL.** If the shape of the data is the volatile part, it goes in MongoDB.

## BullMQ vs Temporal

|               | BullMQ                                                                                                                        | Temporal                                                                                                                                                                                                      |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| What          | Redis-backed job queue                                                                                                        | Durable workflow engine                                                                                                                                                                                       |
| Use for       | Short (< seconds–minutes), retryable, fire-and-forget background jobs: send an email, resize an image, push to DLQ on failure | Long-running (minutes–days), multi-step, stateful workflows: sagas with compensation, human-in-the-loop steps, cron-like durable timers, anything that must survive a deploy mid-flight                       |
| Don't use for | Multi-step orchestration where step 3 depends on step 1's result and the process may take hours → Temporal                    | A single retryable task — Temporal's overhead (worker, task queue, versioning) isn't worth it → BullMQ                                                                                                        |
| In code       | `src/infrastructure/queue/` — queue service + processors + Bull Board UI                                                      | `src/infrastructure/temporal/` — client (`temporal.service.ts`), workflows (`workflows.ts`), activities (`activities.ts`) and the **in-process worker** (`temporal-worker.module.ts`), all inside the backend |

Decision question: **"if the process crashes halfway, does partial completion matter?"** Yes → Temporal. No (safe to just retry the whole job) → BullMQ.

## Elasticsearch vs pgvector

|               | Elasticsearch                                                                                    | pgvector                                                                                          |
| ------------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------- |
| What          | Inverted-index search engine                                                                     | Vector similarity extension in PostgreSQL                                                         |
| Use for       | Full-text search, fuzzy matching, typo tolerance, faceting, relevance scoring on keywords        | Semantic similarity ("find users like this one", RAG retrieval) over embeddings                   |
| Don't use for | "Meaning" similarity — keywords miss synonyms → pgvector                                         | Keyword/fuzzy lookups — embeddings are overkill and can't do exact filtering well → Elasticsearch |
| In code       | `src/infrastructure/elasticsearch/search.service.ts` (user indexing + search), Kibana in compose | `src/infrastructure/postgres/user-vector.service.ts` — `UserService.FindSimilar` gRPC method      |

## Pulsar (behind the MessageBrokerPort)

- **What**: distributed pub/sub message broker — the cross-service event bus.
- **Use when**: a fact happened that _other_ services/systems may care about (`user.created`, …). Always publish **via the outbox** (`src/infrastructure/outbox/`) — never call a broker producer from business code.
- **Not for**: internal background work (BullMQ), request/response (gRPC), orchestration (Temporal).
- **In code**: `src/infrastructure/pulsar/pulsar.module.ts` (client lifecycle), relay in `src/infrastructure/outbox/outbox.relay.ts`, event contract in `packages/shared/src/events/app-event.ts`, consumed by `flink/`.

### MessageBrokerPort — the broker is swappable

The broker sits behind an interface so Pulsar can be replaced (e.g. by Kafka) without touching business code. Lives in `src/infrastructure/messaging/`:

- `message-broker.port.ts` — the `MessageBrokerPort` interface (`publish` / `subscribe` / `close`) and the `MESSAGE_BROKER` injection token. Handler contract: resolve = ack, throw = nack/redeliver.
- `pulsar-broker.adapter.ts` — the (only) adapter today; caches producers per topic and runs receive loops per subscription over the shared Pulsar client.
- `messaging.module.ts` — global module; selects the adapter by the `MESSAGE_BROKER` env var (validated in `config/env.validation.ts`, currently only `pulsar`).

**Rule:** application code (`outbox.relay.ts`, `tracking`, `analytics`, `user` processors) injects `MESSAGE_BROKER` and codes against the port. Inject `PULSAR_CLIENT` directly only for Pulsar-specific concerns (health indicator `modules/health/indicators/pulsar.health.ts`, graceful shutdown in `main.ts`).

**Adding a Kafka adapter:** implement `MessageBrokerPort` in `kafka-broker.adapter.ts`, add a `case 'kafka'` to the switch in `messaging.module.ts`, and add `'kafka'` to the `MESSAGE_BROKER` `valid()` list in `env.validation.ts`. No consumer changes.

## ClickHouse

- **What**: columnar OLAP database.
- **Use when**: append-only analytics — event counts, funnels, time-series aggregations over millions of rows.
- **Not for**: anything you UPDATE/DELETE per-row, or transactional reads → MongoDB/PostgreSQL.
- **In code**: `src/infrastructure/clickhouse/clickhouse.module.ts`, `modules/analytics/`, init SQL in `infra/clickhouse/`, fed by Flink.

## Flink

- **What**: stream processing engine (Java, `flink/`).
- **Use when**: continuous transformation/aggregation of the Pulsar stream before it lands somewhere (currently Pulsar → ClickHouse via `PulsarToClickHouseJob`). Windowing, joins, enrichment on streams.
- **Not for**: one-off batch jobs or per-request logic.

## Vault

- **What**: secrets manager. **Use when**: any credential/API key/signing secret — never hardcode, never commit. **In code**: `src/infrastructure/vault/vault.service.ts`, dev bootstrap in `infra/vault/init.sh` + `policy.hcl`. Production pairing: External Secrets Operator (see `docs/deployment.md`).

## OPA (Open Policy Agent)

- **What**: externalized policy engine (Rego). **Use when**: authorization decisions — role → resource → action — so policy changes don't require app redeploys. **Not for**: authentication (that's `src/modules/auth/` + JWT). **In code**: `src/infrastructure/opa/opa.service.ts`, policy at `infra/opa/authz.rego`.

## MinIO

- **What**: S3-compatible object storage. **Use when**: file uploads, images, exports — anything blob-shaped. **Not for**: structured data or small hot values. **In code**: `src/infrastructure/storage/storage.service.ts`.

## Envoy (gRPC-Web)

- **What**: proxy translating browser gRPC-Web (HTTP/1.1) to backend gRPC (HTTP/2) on :50051. Browsers cannot speak native gRPC — Envoy is mandatory for the frontend's gRPC path. **In code**: `infra/envoy/`, client in the SDK (`packages/sdk/src/client/`, consumed by the frontend via `@tropis/sdk`), proxy at `localhost:8090`.

---

## Rust vs TypeScript

The monorepo is proto-first, so services are language-agnostic at the contract level — but that is a capability, not an invitation. **TypeScript is the default for everything**; Rust is a scalpel, not a second default.

|               | TypeScript (default)                                                                                                                                                                 | Rust (exception)                                                                                                                                                                                   |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Use for       | ALL business logic, CRUD, orchestration, IO-bound work (DB/broker/HTTP calls dominate latency) — one language, shared types (`@tropis/shared`, `@tropis/sdk`), maximum team velocity | A **profiled** hot path that is CPU-bound: crypto, compression, image/video processing, parsing at line-rate; sustained low-latency requirements (p99 in single-digit ms under load); WASM targets |
| Don't use for | A CPU-bound inner loop that profiling shows dominates a service and cannot be fixed in Node                                                                                          | Anything with business rules, evolving schemas, or lots of I/O — you pay the toolchain tax for zero benefit                                                                                        |
| In code       | `apps/backend`, `apps/frontend/helm`, `apps/temporal-worker`, `packages/*`                                                                                                           | `services/rust/signing/` — the live example (HMAC-SHA256 request signatures, pure computation, stateless)                                                                                          |

**Trigger conditions — ALL must hold before writing Rust:**

1. **Profile first.** A flamegraph/`clinic` profile shows a CPU-bound hot path dominating the service — never rewrite on a hunch.
2. **Exhaust Node options first.** `worker_threads`, a native addon (napi-rs/N-API), or an existing optimized npm package (most crypto/compression already binds to C/Rust) didn't solve it.
3. The hot path is **isolatable behind a proto contract** with no shared business state.

**Integration path (zero changes to existing code):**

1. Define the contract in `proto/<domain>/v1/` (buf lint/breaking gate it like any other proto).
2. `make proto` regenerates the TS SDK; the Rust side compiles the same file via `build.rs`.
3. Talk over gRPC (request/response) or Pulsar (events) — existing services just gain another peer.
4. `services/rust/signing/` is the reference: contract `proto/signing/v1/signing.proto`, stateless computation, standard `grpc.health.v1` probes, JSON logs, compose `rust` profile, `rust` CI job.

**Costs (why the bar is high):** a third toolchain in CI and on laptops (after Node and Java/Flink), a smaller hiring/review pool, duplicated conventions (logging, health, config), and cross-language test vectors that must stay in sync (the signing vector is pinned in three suites).

**Decision record:** Rust was considered and **rejected for general use** (2026-08-13). It stays confined to `services/` for profiled CPU-bound hot paths; the backend remains TypeScript/NestJS.

---

## Quick chooser

| I need to…                               | Use                |
| ---------------------------------------- | ------------------ |
| Cache a query result                     | Redis              |
| Store a login session at scale           | Aerospike          |
| Store an order + payment atomically      | PostgreSQL         |
| Store a flexible document / event log    | MongoDB            |
| Send an email in the background          | BullMQ             |
| Run a 3-step onboarding saga over 2 days | Temporal           |
| Keyword search with typos                | Elasticsearch      |
| "Find similar" by meaning                | pgvector           |
| Tell other services something happened   | Outbox → Pulsar    |
| Aggregate 100M events for a dashboard    | Flink → ClickHouse |
| Store an uploaded file                   | MinIO              |
| Fetch a secret                           | Vault              |
| Decide "can role X do action Y"          | OPA                |

---

## Tracking (user behavior instrumentation)

Two deliberate deviations from the defaults above, both scoped to `modules/tracking/`:

1. **Direct-to-Pulsar, no outbox.** The outbox exists to guarantee at-least-once delivery of _domain_ events. Behavioral tracking is high-volume and **lossy-tolerant** — dropping a batch during a broker hiccup costs nothing, while routing every beacon through a MongoDB transaction would double the write load of the hottest endpoint. `TrackingService.ingest()` publishes straight to `persistent://public/default/tracking-events` and logs (not surfaces) failures. Domain events still MUST use the outbox.
2. **REST ingest, gRPC reads.** The SDK tracker flushes on `visibilitychange:hidden`/`pagehide` via `navigator.sendBeacon`, which can only POST plain HTTP — gRPC-Web is impossible there. So ingest is `POST /api/v1/track` (public, validated, 202-immediately, generous throttle) while the read surface (`TrackingService.GetInsights`) stays gRPC-first like everything else.

Sink: an in-process Pulsar consumer (`tracking.processor.ts`) batch-inserts into ClickHouse `logs.user_behavior`; Flink is the scale-out alternative when one Node consumer stops keeping up.

Event names are governed contracts — see [docs/tracking-plan.md](tracking-plan.md) for the naming convention, event registry, and the add-only rule.

## Degradation behavior

What actually happens to the running app when each dependency is down. All of
these are verified in code (paths relative to `apps/backend/src/`). Note that
`GET /api/health` probes Mongo, Redis, ClickHouse, Postgres, Elasticsearch,
MinIO, OPA, Temporal, and Pulsar (`modules/health/health.controller.ts`) — any
one of them being down makes health return **503** (Terminus), so K8s
readiness gates on the full core set even where the code path itself degrades
gracefully.

| Dependency        | When it's down                                                                                                                                                                                                                                                                                                                                                                                                               | Evidence                                                                                                                                  |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| **MongoDB**       | Hard down. System of record — auth, users, outbox all fail; Mongoose buffers briefly then errors. Health 503.                                                                                                                                                                                                                                                                                                                | Mongoose is the primary store; `health.controller.ts` `mongo.pingCheck`                                                                   |
| **Redis**         | Mixed. Login lockout **fails open** by design (an unavailable Redis must not lock everyone out). Cached user reads (`user:<id>`) throw — `get-user.query.ts` does **not** catch Redis errors, so those requests 500 rather than falling through to Mongo. Outbox relay's distributed lock acquisition is caught (`.catch(() => null)`), so relaying quietly **pauses** until Redis returns. BullMQ queues stall. Health 503. | `auth/services/login-lockout.service.ts` (class doc + catches), `user/queries/get-user.query.ts`, `infrastructure/outbox/outbox.relay.ts` |
| **PostgreSQL**    | pgvector/relational queries fail; rest of the app unaffected. Health 503.                                                                                                                                                                                                                                                                                                                                                    | `infrastructure/postgres`, `health/indicators/postgres.health.ts`                                                                         |
| **ClickHouse**    | Graceful. Tracking is "lossy-tolerant": write/read failures are logged and reads **degrade to empty results** ("ClickHouse tracking query failed — returning empty"). Health 503.                                                                                                                                                                                                                                            | `tracking/repositories/tracking.repository.ts` (class doc + catch blocks)                                                                 |
| **Elasticsearch** | Graceful-ish at startup ("search unavailable" warning, app boots); search/index calls at runtime throw to the caller. Re-indexable from Mongo. Health 503.                                                                                                                                                                                                                                                                   | `infrastructure/elasticsearch/search.service.ts` `onModuleInit` catch                                                                     |
| **Pulsar**        | Outbox pattern absorbs it: publish failures mark rows FAILED with the error, and a per-minute cron **requeues failed rows (up to 5 attempts)** — events are delivered late, not lost. Consumers nack on handler errors so Pulsar redelivers. Health 503 (probed last because it's slow when starting).                                                                                                                       | `infrastructure/outbox/outbox.relay.ts` (`markFailed`, `requeueFailed(5)`), `infrastructure/messaging/pulsar-broker.adapter.ts`           |
| **Aerospike**     | Fully graceful: every session operation no-ops or returns `null` when the client is absent or errors (`if (!this.client) return`, all calls try/caught). Login/logout still work; session metadata is just missing. Not in the health check.                                                                                                                                                                                 | `infrastructure/aerospike/session.service.ts`                                                                                             |
| **Vault**         | Graceful at startup: `VAULT_ADDR` unset → "Vault disabled, using .env values"; unreachable → "falling back to .env". Already-set env vars always win. Down mid-run only affects re-reads. Not in the health check.                                                                                                                                                                                                           | `infrastructure/vault/vault.service.ts`, `vault.module.ts`                                                                                |
| **OPA**           | **Fails closed**: non-200 or unreachable → "denying by default". Authorization-gated actions are refused until OPA returns. Health 503.                                                                                                                                                                                                                                                                                      | `infrastructure/opa/opa.service.ts` `allow()`                                                                                             |
| **MinIO**         | Graceful at startup ("file storage unavailable" warning); runtime upload/download calls throw to the caller. Health 503.                                                                                                                                                                                                                                                                                                     | `infrastructure/storage/storage.service.ts` `onModuleInit` catch                                                                          |
| **Temporal**      | Graceful: the client connects lazily and the in-process worker is skipped when Temporal is unreachable (`available` flag), so the app boots and `GET /api/workflows/onboarding` degrades to empty/zero. Onboarding follow-ups are not started while it is down. Health 503.                                                                                                                                                  | `infrastructure/temporal/temporal.service.ts`, `health/indicators/temporal.health.ts`                                                     |

## Vendor swap matrix

Each infra choice sits behind a standard protocol or an in-code port, which is
what determines the cost of swapping vendors:

| Current vendor                                           | Standard interface                                                                        | Swap to                                            | Cost of swapping                                                                                                                                                     |
| -------------------------------------------------------- | ----------------------------------------------------------------------------------------- | -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Jaeger (traces)                                          | **OTLP** via OTel Collector                                                               | Tempo, Zipkin, Datadog, any OTLP sink              | **Config change** — edit the collector's exporter (`infra/otel`); app untouched                                                                                      |
| Prometheus (metrics)                                     | **Prometheus exposition format** (`/api/metrics`)                                         | VictoriaMetrics, Mimir, Grafana Cloud, any scraper | **Config change** — point the new scraper at the same endpoint                                                                                                       |
| MinIO (objects)                                          | **S3 API**                                                                                | AWS S3, GCS (S3 mode), Ceph/R2                     | **Env change** — endpoint/keys in `StorageService` config; same client                                                                                               |
| MailHog (email)                                          | **SMTP**                                                                                  | SES, Postmark, any SMTP relay                      | **Env change** — SMTP host/port/creds                                                                                                                                |
| Pulsar (events)                                          | **`MessageBrokerPort`** (in-code port, `infrastructure/messaging/message-broker.port.ts`) | Kafka, RabbitMQ, NATS                              | **One adapter** — implement the port, rebind the `MESSAGE_BROKER` token; outbox/consumers unchanged                                                                  |
| Pino stdout logs                                         | **JSON lines on stdout**                                                                  | Loki, ELK, CloudWatch, any log shipper             | **Config change** — ship stdout differently; app untouched                                                                                                           |
| Vault (secrets)                                          | **env var merge at boot**                                                                 | AWS/GCP Secret Manager, plain .env                 | **Env change** locally; small adapter if the new manager has no env-merge path (K8s: swap the ESO `SecretStore`)                                                     |
| MongoDB / Postgres / ClickHouse / ES / Redis / Aerospike | Vendor-specific clients behind repositories/services                                      | e.g. Atlas, Aurora, managed CH                     | **Managed same-engine = env change.** Different engine = rewrite the repository/service layer — these are deliberate deep dependencies (see decision sections above) |

## shadcn/ui (frontend UI primitives)

Copy-in component library, not an npm dependency: the primitives under
`apps/frontend/helm/src/components/ui/` are owned source we can restyle and edit
freely, built on Radix primitives (keyboard/focus/ARIA handled for dialogs,
menus, selects) and styled with the same Tailwind v4 design tokens the rest of
the app uses (`src/index.css` exposes shadcn-compatible aliases —
`--color-muted-foreground`, `--color-accent`, … — that point at the existing
palette, so there's no second theme to maintain). Toasts deliberately stay on
the existing Zustand `toastStore` + `Toasts.tsx` instead of sonner: they're
already wired into the WebSocket handlers and mutations, and sonner would add
a parallel toast state store for no gain.

## react-hook-form + zod (frontend forms)

Each form declares a zod schema as the single source of truth for validation —
the frontend mirror of the backend's DTO validation — and react-hook-form
handles registration, submit state and per-field errors without re-rendering
the whole form on each keystroke. `useZodForm` (`src/lib/forms.ts`) wires the
resolver; errors render inline and accessibly (`aria-invalid` +
`aria-describedby`). Reference implementation: `LoginForm.tsx`.

## react-i18next (frontend i18n)

`src/lib/i18n.ts` initializes i18next with **statically bundled** resources
(`src/locales/{en,zh}/common.json`) — no async loading layer for two small
files. English is the default and fallback; detection order is
localStorage → `navigator.language`, and the nav language switcher persists
the choice via the detector's localStorage cache. Keys are namespaced by
feature (`users.*`, `auth.*`, `analytics.*`, `common.*`). Two contracts:
(1) the **e2e suite selects by visible EN text**, so strings in
`en/common.json` that appear in `e2e/tests/*.spec.ts` must not change without
updating the specs; (2) zod validation messages are translated by building
each schema with `t` (`makeSchema(t)` memoized on `[t]`) rather than a global
zod errorMap — messages stay co-located with the schema. `<html lang>` tracks
the active language via a `languageChanged` listener.

## Frontend capability map

Where each frontend concern is handled today, and the pre-decided upgrade
path when it outgrows the current solution, so future maintainers know where
to upgrade:

| Concern           | Current solution                                                                                                                 | When to upgrade / what to                                                                                                  |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Client state      | 3-layer: local `useState` → Zustand (global client state) → TanStack Query (server data). Never mirror server data into Zustand  | If Zustand stores grow interdependent logic, consider slices/middleware before reaching for Redux                          |
| Server cache      | TanStack Query (`state/tanstack/`), staleTime 30s, optimistic updates                                                            | Pagination/infinite lists → `useInfiniteQuery`; realtime-heavy views → invalidate from WS events                           |
| Styling           | Tailwind v4 + design tokens in `index.css`                                                                                       | Stay — tokens are the theme contract; no CSS-in-JS                                                                         |
| Component library | shadcn/ui — copied-in, owned code in `components/ui/` on Radix primitives                                                        | Add primitives by copying from shadcn as needed; never fork to an npm UI kit                                               |
| Forms             | react-hook-form + zod via `useZodForm`                                                                                           | Multi-step wizards → RHF `FormProvider`; schema sharing with backend via `@tropis/shared`                                  |
| i18n              | react-i18next, en (default) + zh, bundled JSON, feature-namespaced keys                                                          | >5 locales or heavy content → lazy-load namespaces (`i18next-http-backend`); add ICU only if plural/gender rules demand it |
| Theming           | class-based dark mode (`html.dark`), pre-paint script in `index.html`, ThemeProvider (light/dark/system)                         | More themes → extend tokens in `index.css`, not per-component styles                                                       |
| Routing           | React Router v6, route-level `lazy()` code splitting                                                                             | Data-heavy routes → router loaders; file-based routing not worth a migration                                               |
| Realtime          | socket.io via SDK (`lib/websocket.ts`) for domain events and the live analytics feed                                             | Fan-out growth → server-side rooms/namespaces; client stays as-is                                                          |
| Tracking          | `@tropis/sdk` tracker → REST `/api/v1/track` (see Tracking section)                                                              | Governed by docs/tracking-plan.md — add events there first                                                                 |
| PWA / offline     | vite-plugin-pwa `autoUpdate`, precache app shell                                                                                 | Offline data → TanStack Query persister + Workbox runtime caching; only with a real offline requirement                    |
| a11y              | eslint-plugin-jsx-a11y (recommended) in CI lint; skip link; `aria-invalid`/`aria-describedby` form pattern; `<html lang>` synced | Ship-blocker audits → add axe-core to Playwright                                                                           |
| Charts            | recharts (analytics + behavior widgets)                                                                                          | >~10k points or 60fps streams → visx or uPlot for canvas rendering                                                         |
| Images            | `loading="lazy"` + explicit dimensions + alt (see project-structure.md); originals from MinIO                                    | Backend sharp thumbnailing is backlog; add `srcset` when images render >32px                                               |
| Virtualization    | None — largest list is the 30-row live feed                                                                                      | Lists >~500 rows → `@tanstack/react-virtual` (don't install until needed)                                                  |
| 2D/3D graphics    | **Deliberately out of scope** — no canvas/WebGL surface in this product                                                          | If it ever appears: pixi.js (2D) / three.js (3D) as an isolated feature                                                    |

### Multi-platform distribution (web / Android / iOS / desktop)

The PWA already gives one codebase on all four platforms: browsers directly;
Android via Chrome's install prompt; iOS via Safari "Add to Home Screen"
(push supported since iOS 16.4); desktop via the Chrome/Edge install button
(standalone window + taskbar icon). Instant updates, no store review.

The native shells are pre-wired in the template (batteries-included), but the
PWA stays the **default** distribution channel. All shells are cheap because
the business logic lives in `@tropis/sdk` + `state/` (platform-agnostic); each
one reuses the web build and swaps only the shell:

| Need                                                     | Tool                | How it works                                                                                                 | Status                                                                                                                                                           |
| -------------------------------------------------------- | ------------------- | ------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Both app stores + native APIs (camera, push, biometrics) | Capacitor           | native shell around the existing web build, JS bridge for native APIs                                        | **Included** — `apps/frontend/helm/capacitor.config.ts` + committed `android/` project; iOS needs Xcode + CocoaPods (see [multi-platform.md](multi-platform.md)) |
| Desktop installers (.dmg/.exe/.deb)                      | Tauri v2            | Rust-based shell (same toolchain as `services/rust/`, but its own crate), ~5MB binaries vs Electron's ~100MB | **Included** — `apps/desktop/`                                                                                                                                   |
| Play Store listing without native APIs                   | TWA (Bubblewrap)    | packages the existing PWA as an APK/AAB, zero code changes                                                   | When needed — superseded by the included Capacitor shell for most cases                                                                                          |
| Fully native UI (last resort)                            | React Native / Expo | rewrite the UI layer; `@tropis/sdk` + stores carry over unchanged                                            | When needed — weeks of effort                                                                                                                                    |

Decision record: shells INCLUDED in the template (owner decision 2026-08-13:
batteries-included foundation; supersedes the earlier PWA-only record). The
PWA remains the default channel; Capacitor/Tauri shells are pre-wired so a
store/desktop requirement is a build away, not a project. Build commands,
prerequisites and env wiring: [docs/multi-platform.md](multi-platform.md).
