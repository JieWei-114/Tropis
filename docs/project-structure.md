# Project Structure

Where everything goes, and why. For how the parts talk to each other at
runtime, see [architecture.md](architecture.md); for local setup and commands,
see [development.md](development.md).

## Monorepo layout

```
.
├── apps/                  Runnable TS-family applications (pnpm workspace)
│   ├── backend/           NestJS API — RPC-first (Connect) + REST + WS
│   │   └── src/           infrastructure/ (capabilities) · common/ (cross-cutting)
│   │                      · modules/ (foundation modules) · features/ (product features)
│   │                      · roles/ (entry points) · config/
│   ├── frontend/
│   │   ├── helm/          helm (the console) — React + Vite SPA (CSR, not indexed),
│   │   │                  also packaged by the Capacitor mobile shells
│   │   └── harbor/        Public site — Next.js App Router (SSR/SSG, full SEO)
│   └── desktop/           Tauri desktop shell (zero business logic)
├── packages/              Importable libraries shared across apps
│   ├── shared/            @tropis/shared — cross-app types, error codes, event contracts
│   └── sdk/               @tropis/sdk — typed client (Connect RPC, REST, realtime,
│                          tracking, request signing; generated types in src/gen/)
├── proto/                 The contracts — <domain>/v1/*.proto (+ <domain>/internal/v1/),
│                          buf-governed, language-neutral source of truth for every API
├── services/              Non-Node code by runtime — services/<runtime>/ (rust/, flink/),
│                          each hosting many services/jobs; plug in via proto/ only
├── e2e/                   Playwright browser E2E suite (@tropis/e2e, black-box, full stack)
├── load/                  k6 load scenarios (black-box, performance)
├── devtools/              Local CLI tools that poke the running stack
│                          (@tropis/devtools — ws-listen, outbox-status, outbox-dead, sdk-repl)
├── infra/                 docker-compose, k8s (base + overlays + local-kind), otel,
│                          prometheus/grafana, vault, opa, temporal, clickhouse, postgres,
│                          argocd, backup
├── docs/                  Foundation documentation
├── .github/               CI workflows, issue/PR templates, release automation
├── Makefile               Developer entrypoints — `make help`
├── buf.yaml               Proto lint/breaking-change gate
├── buf.gen.yaml           SDK codegen (public tier only)
└── Cargo.toml             Cargo workspace for the Rust services (Cargo.lock, rustfmt.toml)
```

pnpm workspace members are `apps/*`, `apps/frontend/*`, `packages/*`, `e2e` and
`devtools` (`pnpm-workspace.yaml`). `services/` and `apps/desktop/src-tauri/`
carry their own toolchains. Local CLI dev tools go in `devtools/`, never inside an
app, so apps ship no dev-only code.

## Foundation and features

The backend is split into what every product needs and what one product adds:

| Tier               | Folder                             | What it is                                                                                                  |
| ------------------ | ---------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Capabilities       | `apps/backend/src/infrastructure/` | One port per capability (cache, messaging, jobs, workflow, …) with its adapters; technology lives only here |
| Cross-cutting      | `apps/backend/src/common/`         | Errors, logging, tracing, tenancy, keyspace, audit trail, authorization (`@Authorize`), guards              |
| Foundation modules | `apps/backend/src/modules/`        | `auth`, `user`, `tenant`, `health`, `notification`, `websocket`: every product runs them                    |
| Product features   | `apps/backend/src/features/`       | `analytics`, `tracking`, `membership-graph`: optional, removable, extractable                               |
| Composition        | `apps/backend/src/roles/`          | One root module per role; enabling a feature is importing it here                                           |

Each tier depends only on the tiers above it in this table, and a feature
never depends on another feature (enforced, [Enforcement](#enforcement-dependency-cruiser)).
The foundation never names a feature: a feature plugs in by registering
with the foundation — its queues (`JobsModule.forFeature`), its workflows
(`WorkflowModule.forFeature`, `WorkflowWorkerModule.forFeature`), its
authorization resource (`@Authorize('<resource>', …)` plus the policy in
`infra/opa/authz.rego`), its metrics (metric providers in its own module) —
so the foundation boots and passes its tests with every feature removed.

A feature reaches a foundation module only through that module's public
surface: its `*.module.ts` files and its `services/`, `constants/`,
`interfaces/` and `dto/`. An event two units share (the user events the
membership graph projects) is a contract in `@tropis/shared`
(`events/user-events.ts`), not an import of the publisher.

## Feature documentation

Two kinds of documentation exist, and each has one owner.

**Foundation documentation** is the set of docs under `docs/` plus the root docs
([README](../README.md), [AGENTS](../AGENTS.md), [CONTRIBUTING](../CONTRIBUTING.md),
[SECURITY](../SECURITY.md)). It describes the foundation as it is. When the
foundation changes, the doc that owns that part is updated in the same change —
otherwise the docs drift from the code and stop being trusted.

**Product features** are documented here, one entry per feature, with fixed
headings: what it owns, how to remove it, and the coupling that removal
still has to touch. Behaviour and rules of a feature live in the doc that
owns the topic (the analytics pipeline in [architecture.md](architecture.md),
tracking events in [tracking-plan.md](tracking-plan.md)). An entry is updated
in the same change as the feature and describes the current state only. A
**temporary feature** (for example a promotion campaign) also states its end
date and teardown in its entry, so it is removed when it ends instead of
accumulating.

| Scope                 | What it is                                                                                 | Why                                                                                                                                                                                                                        |
| --------------------- | ------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Feature** (default) | One folder under `src/features/`; depends only on the foundation, never on another feature | Every feature starts isolated, so it can be removed or extracted without untangling it                                                                                                                                     |
| **Temporary feature** | A feature whose entry below also states its **end date** and the **teardown steps**        | It is removed when it ends instead of accumulating                                                                                                                                                                         |
| **Package**           | Only when a second repository needs the feature: it moves to `packages/` and is published  | Same reason as the [three-tier placement rule](#three-tier-placement-rule-enums--types--utils--constants): promote on the second real consumer. Because a feature is already isolated, extraction is a move, not a rewrite |

Two rules for working on a feature:

- **Contracts first.** A feature that adds or changes a proto RPC, REST
  endpoint, event payload or DB schema gets that contract reviewed (in its issue
  or a draft PR) before the implementation, because once merged a contract is
  add-only (`buf breaking`,
  [api-conventions.md](api-conventions.md#versioning-and-compatibility)).
- **Read before changing.** Before changing a feature, read its entry below and
  the doc sections it links, because they record intent the code cannot show.

**Enabling** a feature is importing its NestJS modules in the role roots that
run them (`apps/backend/src/roles/<role>/<role>.module.ts`: the `-api` module
in public, `-internal` in private, `-worker` in worker, `-schedule` in
scheduler) and adding its route and nav entry in helm's `src/app/App.tsx`.
**Removing** it is the steps in its entry.

### `analytics`

Product analytics events: `AnalyticsService` RPC (create, stats, recent,
per-minute counts), written through the outbox, projected into OLAP by
`AnalyticsProcessor` (or the Flink job), pushed live to the console.

- **Owns:** Mongo collection `eventlogs`; outbox topic `analytics-events`
  (type `analytics.event.recorded`); ClickHouse `logs.analytics_events` and
  `logs.analytics_minutely_agg`; keys (capability:module:name)
  `cache:analytics:stats`, `dedup:analytics:event-seen`; subscription `analytics-processor-sub`;
  authorization resource `analytics`.
- **Remove:** delete `apps/backend/src/features/analytics/`; delete
  `AnalyticsApiModule` from `roles/public/public.module.ts` and
  `AnalyticsWorkerModule` from `roles/worker/worker.module.ts`; delete
  `proto/analytics/` and run `make proto` (drops `src/gen/analytics` and the
  SDK client); remove the analytics calls from `packages/sdk/src/api.ts`, and
  helm `features/analytics/`, `pages/AnalyticsPage.tsx` and its route; then
  the data: the Mongo
  collection, the ClickHouse tables (`infra/clickhouse/init-analytics.sql`)
  and the Pulsar topic.
- **Remaining coupling:** `ANALYTICS_EVENT_TYPES` and
  `EVENT_TYPES.ANALYTICS_EVENT_RECORDED` in `@tropis/shared` (helm and the SDK
  consume them); the `analytics` resource in `infra/opa/authz.rego` (shared
  with tracking insights); `STREAM_ENGINE` and the Flink job
  (`services/flink/`), which consume this topic; the `tracking-analytics`
  Grafana dashboard; `scripts/seed.ts`; the e2e analytics spec.

### `tracking`

User-behavior instrumentation: REST ingest `POST /api/v1/track` (and the
signed `/api/v1/track/secure`), published directly to the broker, written to
OLAP by `TrackingProcessor`; `TrackingService/GetInsights` reads it.

- **Owns:** topic `tracking-events` (type `tracking.batch.received`);
  ClickHouse `logs.user_behavior`; keys `dedup:tracking:event-seen`,
  `dedup:tracking:event-written`; subscription `tracking-processor-sub`;
  metric `tropis_tracking_duplicate_events_dropped_total`.
- **Remove:** delete `apps/backend/src/features/tracking/`; delete
  `TrackingApiModule` from `roles/public/public.module.ts` and
  `TrackingWorkerModule` from `roles/worker/worker.module.ts`; delete
  `proto/tracking/` and run `make proto`; remove the insights call from
  `packages/sdk/src/api.ts`, the tracker (`packages/sdk/src/tracking/`, helm
  `lib/tracking.ts` and its calls) and helm `features/behavior/` with its use
  in `pages/AnalyticsPage.tsx`; then the ClickHouse table (`infra/clickhouse/init-tracking.sql`) and the topic.
- **Remaining coupling:** `TRACKING_EVENTS` in `@tropis/shared` and
  [tracking-plan.md](tracking-plan.md); it authorizes insights against the
  `analytics` resource; the `tracking-analytics` Grafana dashboard; the
  signing tier (`SignatureGuard`, `API_KEYS`) stays foundation.

### `membership-graph`

Projects user events into the graph capability: `(User)-[:MEMBER_OF]->(Tenant)`
and `(User)-[:INVITED]->(User)`, queried through `MembershipGraphService`.
Off unless `GRAPH_ADAPTER=neo4j`.

- **Owns:** graph labels `User`, `Tenant` and relationships `MEMBER_OF`,
  `INVITED`; key `dedup:membership-graph:event-seen`; subscription
  `membership-graph-sub` on `user-events`.
- **Remove:** delete `apps/backend/src/features/membership-graph/`; delete
  `MembershipGraphWorkerModule` from `roles/worker/worker.module.ts`; delete
  `test/integration/features/membership-graph/`; then the graph
  data and the subscription (`pulsar-admin topics unsubscribe … -s
membership-graph-sub`).
- **Remaining coupling:** none in code; it reads the shared user events
  contract.

## `services/` — polyglot services

Non-Node code lives here, **one folder per runtime** (`services/rust/`,
`services/flink/`); each runtime folder owns its toolchain (Cargo, Maven),
build, packaging and CI job, and hosts many services or jobs. They are not pnpm
workspace packages. The contract with the rest of the system is always a proto in `proto/`
(buf-linted, `buf breaking`-gated), transported over gRPC or Pulsar; nothing
imports across the language boundary. When to add one (almost never — profile
first): [tech-decisions.md → Rust vs TypeScript](tech-decisions.md#rust-vs-typescript).
The add-a-service checklist and the Rust workspace commands live in
[services/README.md](../services/README.md).

A **service** is a deployable unit; a **feature** of an existing service is a
module inside its `domain/` (signature verification is `domain/signature.rs`
of the signing service). A new feature of an existing domain never becomes a
new service.

`services/` is organised **per runtime**, unlike `src/infrastructure/` in the
backend, which is organised per capability. The difference is deliberate: in
the backend the capability is what stays (cache, messaging) and the technology
behind it is an adapter that can be swapped; here the runtime is what stays,
and it carries many unrelated features (a Rust service for signing, another for
image processing; one Flink job for analytics, another for fraud scoring).
Naming the folder after one feature would tie the runtime's toolchain, CI job
and build to that feature. So the path is `services/<runtime>/<service>/`, and
each service inside is an independently deployable unit (own Dockerfile or job
entry, own compose entry). Rust services are members of the **Cargo
workspace** rooted at the repo root: `Cargo.toml` lists `services/rust/*`, so a
new crate joins without editing it, and carries the shared dependency versions
(`[workspace.dependencies]`) and the release profile, with one `rustfmt.toml`,
a single `Cargo.lock` and `target/` at the repo root. Flink jobs share one
Maven project and one fat JAR; each job is a class in `jobs/`, selected at
submit time. Each service keeps its **own Dockerfile** (a service is the
deployable unit — it builds, deploys and scales independently; the image builds
only its crate via `cargo build --release -p <crate>`).

- `services/rust/signing/` — Rust gRPC service computing/verifying HMAC request
  signatures (`tropis.signing.v1`, contract `proto/signing/v1/signing.proto`);
  the reference implementation for the pattern.
- `services/flink/` — Java (Maven) Flink jobs; `jobs/PulsarToClickHouseJob`
  streams `analytics-events` from Pulsar into ClickHouse.

## Rust service anatomy

Every Rust service under `services/rust/<name>/` follows this layout — the
polyglot mirror of the backend module anatomy. **Copy `services/rust/signing/`
as the template for a new Rust service.**

```
Cargo.toml                   # Repo root: workspace members, shared dep versions, release profile
rustfmt.toml                 # Workspace-level formatting (anchor for `cargo fmt --check`)
Cargo.lock                   # Single lockfile (single target/ too — gitignored)
services/rust/<name>/
├── Cargo.toml               # Workspace member — inherits edition/license/deps
│                            # via `{ workspace = true }`. NOT a pnpm package.
├── build.rs                 # Compiles the shared contract from proto/ (tonic-prost-build)
├── Dockerfile               # Multi-stage; build context = repo root (needs proto/
│                            # + the workspace manifests); builds only this crate (-p)
├── README.md
├── src/
│   ├── main.rs              # Bootstrap ONLY: load config, init tracing, wire
│   │                        # the server, serve. No logic — mirrors backend main.ts.
│   ├── lib.rs               # Module wiring + generated `pb` types; declares the
│   │                        # layer visibility (see enforcement below).
│   ├── config.rs            # Env parsing + validation into a typed struct.
│   │                        # Fail fast with a clear message — mirrors the
│   │                        # backend's Joi env validation (src/config/).
│   ├── error.rs             # Domain error enum + `From<DomainError> for tonic::Status`
│   │                        # — ONE place maps domain errors → catalog code,
│   │                        # status and ErrorInfo; mirrors the backend's
│   │                        # exception filters.
│   ├── grpc/                # Transport layer — mirrors backend controllers/:
│   │   ├── mod.rs           # THIN. Decode request → call domain → encode
│   │   └── <feature>.rs     # response. No business logic.
│   ├── domain/              # Business logic — mirrors backend services/:
│   │   ├── mod.rs           # PURE where possible (no IO), fully unit-tested.
│   │   └── <feature>.rs     # No tonic/prost types anywhere in here.
│   └── infra/               # External clients (redis/db/brokers) — mirrors
│       └── mod.rs           # backend infrastructure/: one client per system,
│                            # behind a trait so domain/ depends on the
│                            # abstraction. Keep the module (with a doc comment)
│                            # even when empty, as signing does.
└── tests/                   # Integration tests: spawn the real tonic server on
    └── grpc_test.rs         # an ephemeral port, call it with a generated client
                             # — mirrors apps/backend test/integration.
```

### One-way rule — crate boundary by the compiler, direction by review

```
grpc/  →  domain/  →  infra/ (via traits)
```

The compiler enforces the **crate boundary**:

- `domain/`, `error` and `infra/` are `pub(crate)` and `grpc` is `pub`
  (declared in `lib.rs`), so domain and infra types can never appear in the
  crate's public API; a `pub` signature exposing one fails to compile (E0446).
- `main.rs` is a separate bin crate consuming the lib: it can only reach the
  `pub` surface (`config`, `grpc`, `pb`), so it cannot call domain logic
  directly. The same applies to `tests/`, which forces integration tests
  through the real transport.

The **direction inside the crate** is a code-review rule: `pub(crate)` does not
stop `domain/` importing `grpc/`, or `grpc/` calling `infra/` directly. Reviewers
reject both, because each layer must be replaceable without touching the
others. `domain/` imports no tonic/prost types — proto structs are decoded into
plain domain structs at the `grpc/` boundary, so the transport can be swapped
without touching business logic.

### Naming convention

- Folder: `services/<runtime>/<service>` (`services/rust/signing`) — the
  runtime first, then the service's responsibility name.
- Proto package, service name and deployment names stay **language-neutral**:
  package `tropis.signing.v1`, crate/binary `signing`, compose service `signing`
  — so reimplementing a service on another runtime moves its folder but
  changes no contracts or deployment names.
- Rust files: snake_case, one feature per file inside each layer
  (`domain/signature.rs`, `grpc/signing.rs`).

### Hard rules (Rust mirror of the backend hard rules)

1. `main.rs` is bootstrap only — config, tracing, server wiring, shutdown.
2. `grpc/` handlers are thin — decode, delegate, encode. Reason strings and
   error codes come from `domain/`/`error.rs`, never inline.
3. `domain/` is pure and unit-tested; anything doing IO belongs in `infra/`
   behind a trait.
4. Error → status mapping happens only in `error.rs`, and every error is an
   entry of the shared error catalog: its gRPC code and public message, plus a
   `google.rpc.ErrorInfo` detail naming the code, as the backend's RPC errors
   carry ([api-conventions.md](api-conventions.md#errors)).
5. Dependency versions live in `[workspace.dependencies]` of the root
   `Cargo.toml`; a service references them with `{ workspace = true }`, so
   every service runs identical versions.
6. Behavior shared across languages (the HMAC test vector, also pinned in the
   backend signature guard and SDK signing tests) carries a sync comment
   naming every copy.
7. There is no shared library crate: code stays in the one service that uses
   it and becomes a shared workspace member only when a second Rust service
   needs it (the [three-tier placement rule](#three-tier-placement-rule-enums--types--utils--constants)).
8. Verify from the workspace root (the repo root) with `cargo fmt --check`,
   `cargo clippy --workspace --all-targets -- -D warnings`, and
   `cargo test --workspace` (unit + integration). CI runs the same three.

## Backend module anatomy

Every foundation module under `apps/backend/src/modules/<name>/` and every
product feature under `apps/backend/src/features/<name>/` follows this
layout:

```
<name>/
├── <name>.module.ts         # Services and storage, no transport — imported by the modules below;
│                            #   imports every capability module it injects (CacheModule.forRoot(), …)
├── <name>-api.module.ts     # REST + public RPC controllers (public role)
├── <name>-internal.module.ts # internal-tier RPC controllers (private role)
├── <name>-worker.module.ts  # processors, job handlers, workflow worker registration (worker role)
├── controllers/             # REST + RPC handlers (*.rpc.controller.ts, @RpcService). THIN.
│                            # No business logic — parse input, call a service, return a DTO.
├── gateways/                # WebSocket gateways. Thin like controllers.
├── services/                # ALL business logic lives here.
├── repositories/            # The ONLY place that touches the ODM (Mongoose models).
├── schemas/                 # Mongoose schemas. NEVER returned directly from an API.
├── processors/              # Broker subscribers (through EventConsumer) and @JobHandler
│                            # job handlers. Thin like controllers — delegate to services.
├── workflows/               # *.workflow.ts (workflow definitions, engine SDK), activity
│                            # providers and the worker registration (worker role only)
├── dto/                     # Input validation (class-validator) + response shapes.
├── transformers/            # entity → dto/proto mapping. Strips internal fields
│                            # (_id, __v, passwordHash…). The only door out.
├── interfaces/              # Module-internal TypeScript types.
├── constants/               # Queue definitions, topics, event names, key definitions,
│                            # error-code aliases, the authorization resource. NO magic strings.
├── utils/                   # Module-only pure functions. Zero DI, zero IO. Must be unit-tested.
└── __tests__/               # Unit tests for the module.
```

A module creates only the folders and module files it uses; the split into
module files is what lets each role import only its own transport and
connect only to the capabilities that transport needs
([Roles](#srcroles--entry-points-and-role-roots)).

Foundation modules:

| Module         | Shape                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `user`         | Every layer except `utils/` and `gateways/`, plus CQRS folders `commands/`, `queries/`, `events/`, `event-store/`; the closest live example. Module files: `user.module.ts` (users, CQRS, storage), `user-search.module.ts` (search + similarity, public and worker), `user-onboarding.module.ts` (the onboarding follow-up), `user-api.module.ts`, `user-internal.module.ts`, `user-worker.module.ts` (the user events consumer, the onboarding worker) |
| `auth`         | `controllers/`, `services/` (including the one `TokenVerifier` for REST, RPC and WebSocket), `dto/`, `interfaces/`, `constants/`, `decorators/` (`@OAuthProvider`), `guards/` (the JWT auth guard, the OAuth-configured guard) and `strategies/` (OAuth providers)                                                                                                                                                                                       |
| `tenant`       | `tenant-directory.module.ts` (imported by auth and user), `services/` (`TenantDirectoryService`, the `TENANT_DIRECTORY` port from `common/tenant/`, cached 60 s), `repositories/`, `schemas/` (the `tenants` collection), `constants/`; no controllers: tenants are registered with `make tenant-create`                                                                                                                                                 |
| `notification` | `processors/` (the `notification` job handler), `services/` (`NotificationService`: `enqueue()` for producers, delivery through the `MAIL` and `REALTIME` ports), `constants/` (the queue definition); one `notification.module.ts`, imported by worker modules                                                                                                                                                                                          |
| `websocket`    | `gateways/` — holds client sockets and attaches the realtime transport; producers publish through `REALTIME`, never through the gateway                                                                                                                                                                                                                                                                                                                  |
| `health`       | `health.module.ts` (probes + `ops-server.ts` on `OPS_PORT`, every role), `health-api.module.ts` + `controllers/health.controller.ts` (`GET /api/health`, public role), `health-rpc.module.ts` + `controllers/health.rpc.controller.ts`, `health.probes.ts` (probe keys and per-role readiness sets), `services/`                                                                                                                                         |

Product features are listed in [Feature documentation](#feature-documentation).

### Hard rules

1. **One-way dependency flow, no layer-skipping:**

   ```
   controllers/ , gateways/ , processors/  →  services/  →  repositories/  →  schemas/
   ```

   A transport never imports a repository. A service never imports a Mongoose
   model or connection directly, and opens a transaction with
   `DocumentsPort.withTransaction` (`DOCUMENTS`), passing its `tx` to every
   repository write and to `OutboxService.write`. If you need data, ask the
   layer below you — so storage can change without touching the transports.

2. **Schemas never cross the API boundary.** Every response goes through a
   transformer, because a schema carries internal fields (`_id`, `__v`,
   `passwordHash`) that must never leak.

3. **No magic strings.** Queue definitions, event names, topics and keys →
   `constants/`, so a rename happens in one place and a typo is a compile error.
   Cache, kv, lock, ratelimit and dedup keys are declared there with
   `defineKey()` from `src/common/keyspace/` (tenant scope and TTL are part of
   the definition); error codes are entries of the shared catalog
   (`packages/shared/src/errors/catalog.ts`,
   [api-conventions.md](api-conventions.md#errors)), aliased in `constants/`.

4. **utils/ are pure.** If it needs injection or does IO, it's a service.

5. **Cross-module access goes through the other module's services or events**,
   never its `repositories/`, `schemas/` or `event-store/`.

6. **A module owns what it registers.** Its queues (`JobsModule.forFeature`),
   workflows (`WorkflowModule.forFeature` for the types it starts,
   `WorkflowWorkerModule.forFeature` in its worker module for the definitions
   and activities), metrics (`makeCounterProvider` and friends as providers of
   its own module) and authorization resource (`@Authorize('<resource>', …)`)
   are declared by the module itself, so the foundation holds no list of them
   and removing the module removes them.

7. **Authorization is declared, not coded.** A handler that requires a
   permission carries `@Authorize(resource, action)`; the HTTP
   `AuthorizeGuard` and the RPC authorization interceptor enforce it before
   the handler runs. A handler only calls `AuthorizationService.allows()` (or
   `RpcAuthzService.allows()`) when it branches on a permission instead of
   requiring it (`UserService/Create`); record ownership checks stay in the
   handler.

8. **Consumers go through `EventConsumer`.** A processor subscribes with
   `EventConsumer.subscribe()` (decoded data, the envelope tenant bound, data
   naming another tenant dropped) and wraps its work in `once()` /
   `onceEach()` (the dedup claim, its TTL below the ack timeout, extend on
   success, release on failure), so no processor re-implements the delivery
   rules.

### Enforcement (dependency-cruiser)

Config: `apps/backend/.dependency-cruiser.cjs`; run with
`pnpm --filter @tropis/backend lint:arch` (CI runs it in the backend job). All
rules are `error` severity. It cruises `src/` and `test/`; unit tests under
`src/` are excluded, and the suites under `test/` are checked only by the two
test rules.

| Rule                                          | Blocks                                                                                                                                                                                                                                                                                                          |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `no-circular`                                 | Runtime dependency cycles (type-only cycles are allowed)                                                                                                                                                                                                                                                        |
| `foundation-not-into-business`                | `src/infrastructure/`, `src/common/` or `src/config/` importing `src/modules/` or `src/features/`                                                                                                                                                                                                               |
| `foundation-tests-not-into-features`          | A suite under `apps/backend/test/` importing `src/features/`, unless it lives under `test/integration/features/<name>/`, so deleting a feature leaves the foundation suites intact                                                                                                                              |
| `feature-tests-only-into-own-feature`         | A suite under `test/integration/features/<name>/` importing another feature                                                                                                                                                                                                                                     |
| `modules-not-into-features`                   | A foundation module (`src/modules/`) importing a product feature (`src/features/`)                                                                                                                                                                                                                              |
| `no-cross-feature-imports`                    | One feature importing another                                                                                                                                                                                                                                                                                   |
| `features-use-module-public-surface`          | A feature importing anything of a foundation module except its `*.module.ts` files and its `services/`, `constants/`, `interfaces/`, `dto/`                                                                                                                                                                     |
| `transports-not-into-repositories-or-schemas` | `controllers/`, `gateways/` or `processors/` → `repositories/` / `schemas/`                                                                                                                                                                                                                                     |
| `no-cross-unit-repositories-or-schemas`       | Module or feature A → B's `repositories/`, `schemas/` or `event-store/`                                                                                                                                                                                                                                         |
| `only-adapters-import-drivers`                | Runtime imports of a driver package (the `DRIVER_PACKAGES` list: `ioredis`, `pulsar-client`, `kafkajs`, `pg`, `typeorm`, `bullmq`, `nodemailer`, `neo4j-driver`, `socket.io`, `@temporalio/*`, …) outside `src/infrastructure/*/adapters/` and `src/infrastructure/connections/`. Type-only imports are allowed |
| `mongoose-only-in-persistence`                | Runtime `mongoose` / `@nestjs/mongoose` imports outside adapters, connections, each unit's `repositories/`, `schemas/`, `event-store/` and `*.module.ts` files (schema registration), and the outbox schema, service and module                                                                                 |
| `workflow-sdk-only-in-workflows`              | `@temporalio/workflow` imported outside adapters and `*.workflow.ts` files                                                                                                                                                                                                                                      |
| `ports-have-no-driver-types`                  | Any `*.port.ts` (in `infrastructure/` or `common/`) importing a driver package, even type-only                                                                                                                                                                                                                  |
| `business-not-into-capability-adapters`       | `src/modules/`, `src/features/` or `src/common/` importing an adapter; business code injects the port token, and the capability module picks the adapter from config                                                                                                                                            |
| `business-not-into-connections`               | `src/modules/`, `src/features/` or `src/common/` importing `src/infrastructure/connections/`                                                                                                                                                                                                                    |
| `connections-only-from-adapters`              | Infrastructure files other than adapters, connections and capability `*.module.ts` files importing `connections/`                                                                                                                                                                                               |
| `roles-are-composition-roots`                 | Anything outside `src/roles/`, `main.ts` and `app.module.ts` importing a role root                                                                                                                                                                                                                              |
| `roles-import-no-other-role`                  | One role root importing another; only the `all` root (`app.module.ts`) combines them                                                                                                                                                                                                                            |
| `public-role-no-background-work`              | `roles/public/` reaching (transitively) processors, `*.job.ts`, `workflows/` and `*.workflow.ts`, `*.schedule.ts`, the outbox relay, the job workers or the workflow worker                                                                                                                                     |
| `private-role-internal-rpc-only`              | `roles/private/` reaching any controller except `*-internal.rpc.controller.ts` and the health RPC controller, gateways, the dashboard or background work                                                                                                                                                        |
| `worker-role-no-inbound-api`                  | `roles/worker/` reaching controllers, gateways, `infrastructure/rpc/`, the dashboard or `*.schedule.ts`                                                                                                                                                                                                         |
| `scheduler-role-only-enqueues`                | `roles/scheduler/` reaching controllers, gateways, `infrastructure/rpc/`, the dashboard or background work                                                                                                                                                                                                      |
| `crons-only-in-schedules`                     | `@nestjs/schedule` imported outside `*.schedule.ts` and the scheduler root (`roles/scheduler/scheduler.module.ts`, which registers `ScheduleModule`)                                                                                                                                                            |

Carve-outs, and why:

- `mongoose` and `@nestjs/mongoose` are the drivers allowed outside adapters:
  repositories are the documents adapter layer of their module, because a
  query-shaped documents port would only re-implement the ODM; a module file
  registers its schemas with `MongooseModule.forFeature`.
- `*.workflow.ts` may import `@temporalio/workflow`: a workflow definition
  runs inside the engine and is written against its SDK. It lives in the
  owning module's `workflows/`, which only the worker role reaches.

### Three-tier placement rule (enums / types / utils / constants)

> **Start at the smallest scope; promote when a second consumer appears.**

| Tier | Where                                                              | When                                                             |
| ---- | ------------------------------------------------------------------ | ---------------------------------------------------------------- |
| 1    | `<modules or features>/<name>/constants/`, `interfaces/`, `utils/` | Used by a single module                                          |
| 2    | `apps/backend/src/common/`                                         | Used by 2+ backend modules                                       |
| 3    | `packages/shared/src/`                                             | Shared with frontend / SDK, or an event contract two units share |

Never put something in `packages/shared` "just in case" — promote on the second
real consumer. Code that is shared early is shaped by guesses, and every extra
consumer makes it harder to change.

## Adding a backend module — step by step

Example feature: `order` (a product feature, so under `src/features/`; a
foundation module goes under `src/modules/` and follows the same steps).
Read `modules/user/` alongside these steps; it is the closest live example.

1. **Proto.** Create `proto/order/v1/order.proto` (package `tropis.order.v1`,
   service `OrderService`). Add-only rules apply from day one —
   [api-conventions.md](api-conventions.md). Run `buf lint` / `buf breaking`.

   ```proto
   syntax = "proto3";
   package tropis.order.v1;

   service OrderService {
     rpc Create (CreateOrderRequest) returns (OrderResponse);
     rpc FindById (FindOrderRequest) returns (OrderResponse);
   }
   ```

2. **Generate types.** Run `make proto` to regenerate the protobuf-es types in
   `packages/sdk/src/gen/` and `apps/backend/src/gen/`. No listener
   registration is needed: `RpcServer` discovers every `@RpcService` provider,
   and the proto path decides the tier (`proto/<domain>/internal/v1/` is
   served only on the internal listener).
3. **Skeleton.** `features/order/order.module.ts` plus the folders from the
   [anatomy](#backend-module-anatomy) it needs, and its entry in
   [Feature documentation](#feature-documentation).
4. **Schema** — `schemas/order.schema.ts`: Mongoose schema (money →
   PostgreSQL through a capability). Never returned from an API.
5. **Repository** — `repositories/order.repository.ts`: the only file that
   touches the ODM. Expose intent-named methods (`findById`, `create(tenantId,
data, tx?)`), not query builders.
6. **Service** — `services/order.service.ts`: all business logic. Injects the
   repository, `OutboxService` and capability ports (`JOBS`, `CACHE`, …) —
   never drivers. On state change, write the domain row **and the outbox
   entry in one transaction**: `DOCUMENTS.withTransaction(async (tx) => {
repo.create(…, tx); outbox.write({…}, tx); })` (see
   `modules/user/commands/create-user.command.ts`).
7. **Capabilities** — `order.module.ts` imports every capability module its
   providers inject (`DocumentsModule.forRoot()`, `OutboxModule.forRoot()`,
   `CacheModule.forRoot()`, …). Each `forRoot()` returns one shared module, so
   importing it again elsewhere opens nothing twice, and a role connects only
   to what its modules import.
8. **Controllers** — `order.rpc.controller.ts`, decorated with
   `@RpcService(OrderService)` and registered as a provider of the `-api`
   module, implements `tropis.order.v1.OrderService`: `@Authorize('order',
'create')` on each method that needs a permission, then validate → service →
   transformer. Add the `order` resource to `infra/opa/authz.rego`. A REST
   controller only for a REST-only case (upload, OAuth callback, webhook — see
   [api-conventions.md](api-conventions.md)).
9. **Transformer** — `transformers/order.transformer.ts`: entity → proto/DTO,
   strips internal fields (compare `modules/user/transformers/user.transformer.ts`).
10. **Constants** — `constants/order.constants.ts`: topics (logical names, e.g.
    `order-events`), event names, key definitions (`defineKey()`), queue
    definitions, the authorization resource and aliases of the order's catalog
    error codes (new codes go into `packages/shared/src/errors/catalog.ts`).
11. **Domain events** — add the type to `EVENT_TYPES` in
    `packages/shared/src/events/event-types.ts` (`ORDER_PLACED:
'sales.order.placed'`); an event another unit consumes also gets its data
    type next to it (see `events/user-events.ts`); rebuild:
    `pnpm --filter @tropis/shared build`.
12. **Outbox publish** — `OutboxService.write({ topic, aggregateId, type,
tenantId, data }, tx)` stores the event with its CloudEvents attributes;
    the relay (`src/infrastructure/outbox/outbox.relay.ts`) publishes `data` as
    the body through the `MESSAGING` port, in order per aggregate. Domain
    events always go through the outbox; lossy-tolerant telemetry
    (`features/tracking/`) publishes directly — see
    [tech-decisions.md → Tracking](tech-decisions.md#tracking-user-behavior-instrumentation).
13. **Processors** — a broker consumer subscribes through `EventConsumer`
    (`MessagingModule.forRoot()`; pattern: `modules/user/processors/user.processor.ts`)
    and delegates to a service; a job handler is `@JobHandler(queue)` with the
    queue declared by `JobsModule.forFeature([ORDER_QUEUE])` in the module
    that owns it (pattern: `modules/notification/`). Both are provided only by
    the `-worker` module.
14. **Tests** — unit: `__tests__/order.service.spec.ts` with a mocked repository
    (pattern: `modules/user/__tests__/user.service.spec.ts`); integration:
    `apps/backend/test/integration/order.integration.spec.ts` with Testcontainers
    (a product feature's suite goes in `test/integration/features/<feature>/`)
    (`make test-int`). Details: [testing.md](testing.md).
15. **Wire it up** — import each module file in the role root that runs it
    (`src/roles/public/public.module.ts`, `src/roles/worker/worker.module.ts`,
    …); `lint:arch` rejects a controller reachable from the worker, a
    processor reachable from public, and any import of another feature. New
    env vars go into the Joi schema and `.env.example`; read them with
    `config.getOrThrow()` when the schema has a default, never with a second
    default at the call site.

Checklist:

- [ ] proto in `proto/order/v1/`, buf passes, `make proto` run
- [ ] one-way layering respected (`pnpm --filter @tropis/backend lint:arch`)
- [ ] capability modules imported where injected
- [ ] `@Authorize` on every protected handler, resource in `authz.rego`
- [ ] transformer on every outbound shape
- [ ] constants file, no magic strings
- [ ] event type in `packages/shared`, published via outbox
- [ ] unit + integration tests
- [ ] modules split by transport and imported in the role roots that run them
- [ ] entry in [Feature documentation](#feature-documentation) with the removal steps
- [ ] `.env.example` + Joi schema updated if new config

## `src/common/` layout

Cross-module backend concerns (tier 2). `common/` never imports a module or
a feature; it may use capability ports.

```
common/
├── audit/             # AuditModule, AuditLogService (logs.audit_log through OLAP),
│                      #   @Audited(), the HTTP AuditInterceptor (the RPC server
│                      #   audits through infrastructure/rpc/interceptors/)
├── auth/              # TokenVerifier port + request credential extraction (REST, RPC, WS)
├── authz/             # @Authorize(resource, action), AuthorizationService (POLICY port),
│                      #   AuthorizeGuard (HTTP), AuthzModule
├── errors/            # AppError, normalisation to catalog codes, RFC 9457 problem details,
│                      #   validation field violations
├── keyspace/          # defineKey() builders, branded key and TenantId types
├── observability/     # logger port, metrics registry module + RED metrics, W3C trace
│                      #   propagation, request context, PII redaction, service info
├── tenant/            # tenant resolution + context + middleware + module, the
│                      #   TenantDirectory port (implemented in modules/tenant/)
├── guards/            # signature.guard + api-key.service + throttler-behind-proxy
│                      #   (the JWT auth guard lives in modules/auth/guards/)
├── filters/           # http-exception.filter (HTTP errors; RPC errors are mapped
│                      #   in infrastructure/rpc/rpc-errors.ts)
├── interceptors/      # http-tenant.interceptor (binds TenantContext for HTTP)
├── middleware/        # correlation-id + http-metrics middleware
├── decorators/        # @CurrentUser(), @Public(), @RequireSignature()
├── circuit-breaker/
└── utils/             # tier-2 pure helpers (escape-html, object-id)
```

How these behave at runtime (tenancy, tracing, logging, errors):
[architecture.md](architecture.md) and
[api-conventions.md](api-conventions.md#errors).

`pipes/`, `enums/`, `types/` do not exist; create one only for a tier-2
consumer, because empty folders invite speculative code.

## `src/roles/` — entry points and role roots

One codebase, four deployable roles, each its own entry point and root module
([architecture.md](architecture.md#backend-roles)):

```
src/main.ts                  the `all` entry (every role in one process, `make dev`); root: src/app.module.ts
src/roles/
├── all/role.ts              sets SERVICE_ROLE=all for src/main.ts
├── shared/
│   ├── core.module.ts       validated config, observability, tenant context, event emitter, metrics registry, ops listener
│   ├── validated-config.ts  Vault KV into process.env, then the validated ConfigModule
│   ├── bootstrap.ts         bootstrapRole(): process guards, surfaces, ops port; shutdownRole() on SIGTERM/SIGINT
│   ├── http.surface.ts      Express app + HTTP config (public, all)
│   └── rpc.surface.ts       RPC listeners per tier
├── public/                  role.ts, main.ts, public.module.ts     HTTP, public RPC, WebSocket
├── private/                 role.ts, main.ts, private.module.ts    internal RPC
├── worker/                  role.ts, main.ts, worker.module.ts     consumers, relay, job workers, workflow workers
└── scheduler/               role.ts, main.ts, scheduler.module.ts  cron triggers that enqueue jobs
```

- `role.ts` is the entry's first import: it sets `SERVICE_ROLE` before tracing
  starts, so every span and log record carries the role.
- `CoreModule` holds nothing that touches a datastore. A root imports module
  files by transport (`-api`, `-internal`, `-worker`), foundation modules
  first and product features after them, and the capability-side role
  modules (`infrastructure/jobs/jobs-workers.module.ts`,
  `jobs-dashboard.module.ts`, `outbox/outbox-relay.module.ts`,
  `outbox-schedule.module.ts`, `WorkflowWorkerModule.forRoot()`); the
  capabilities come in with the modules that use them. So the scheduler
  connects only to the jobs store, the private role only to what the
  internal user RPC needs, and a capability no imported module uses is never
  connected.
- `esbuild.config.mjs` bundles each role entry from the tsc output into
  `dist/<role>/main.js`, and every `*.workflow.js` beside the worker bundle,
  so a role's bundle and image contain only the code its root reaches;
  `pnpm start:<role>` runs it.
- A cron is a `*.schedule.ts` provider whose method only enqueues a job; the
  work is a `@JobHandler` in a `*.job.ts` or processor that the worker runs.

## `src/infrastructure/` — capability ports and adapters

Each capability is named by its responsibility; the technology is an adapter
behind it, so swapping or mocking a datastore is a configuration change.

```
infrastructure/
├── <capability>/
│   ├── <capability>.port.ts   interface + DI token (a Symbol, e.g. CACHE); domain types only
│   ├── <capability>.module.ts forRoot(): one shared module per process; picks the adapter from
│   │                          its <CAPABILITY>_ADAPTER env var and imports only that adapter's connection
│   ├── <capability>.health.ts reports up / down / disabled
│   ├── adapters/<tech>/       the implementation over one driver
│   ├── adapters/disabled/     every call throws CapabilityDisabledError (the cache's is a pass-through)
│   └── __tests__/             unit tests; <capability>.conformance.ts (where present) is the suite every adapter passes
├── capability/                adapter selection, conditional connection imports, disabled error, health, TTL helpers
├── connections/<tech>/        driver clients shared by several adapters (redis, pulsar, aerospike)
├── outbox/                    OutboxService, relay (worker), sweep schedule (scheduler)
└── rpc/                       the RPC server
```

Business code injects a port by its token and never imports an adapter, a
connection or a driver at runtime (the rules in
[Enforcement](#enforcement-dependency-cruiser)).

**Modelling.** Every capability module has the same shape, so a reader knows
one and knows all:

- `forRoot()` returns the same module object on every call, so each Nest
  module that injects a capability imports `XModule.forRoot()` itself, and a
  process still gets one instance. Capability modules are not global: a
  missing import fails at boot instead of working only while some other
  module happens to import it.
- A connection is imported only when the selected adapter needs it
  (`importWhenSelected` in `capability/conditional-import.ts`): Redis only
  when a redis adapter is selected, Pulsar only with `MESSAGING_ADAPTER=pulsar`,
  Aerospike only with `KV_ADAPTER=aerospike`, the Postgres pool only when the
  vector capability is imported with `VECTOR_ADAPTER=pgvector`. The selection
  is read after the Vault KV secrets are merged (`secrets/secrets-env.ts`),
  never at import time, so Vault can supply it.
- A capability that serves several modules has an open registry instead of a
  list: `JobsModule.forFeature(queues)` (`jobs.registry.ts`; the capability
  owns only the dead-letter queue and its `DeadLetterJob`),
  `WorkflowModule.forFeature({ queue, workflowTypes })` and
  `WorkflowWorkerModule.forFeature({ queue, workflowsPath, activities })`
  (`workflow.registry.ts`; one engine worker per queue). A queue or workflow
  exists in a role only when a module of that role declares it.
- Health probes are named by capability; a connection has no probe of its
  own, because the capability probe already reaches it through its adapter.

**File naming.** A technology name appears exactly where the code depends on
that technology, and nowhere else:

| Where                                   | Name                            | Example                                                                               |
| --------------------------------------- | ------------------------------- | ------------------------------------------------------------------------------------- |
| Capability folder, port, module, client | capability only                 | `cache/`, `cache.port.ts`, `cache.client.ts`                                          |
| Inside `adapters/<tech>/`               | `<tech>-<capability>.<kind>.ts` | `redis-cache.store.ts`, `pulsar-messaging.adapter.ts`, `temporal-workflow.adapter.ts` |
| Inside `connections/<tech>/`            | `<tech>-<role>.<kind>.ts`       | `redis-connection.module.ts`, `pulsar.probe.ts`                                       |

Why: business code imports only the capability names, so it reads as what it
needs ("cache") and survives a technology swap untouched; adapter files carry
the technology so an editor tab, a stack trace or a search result says which
technology the code belongs to. Since modules may not import `adapters/` or
`connections/`, a technology-named import in business code is itself the
violation, visible at a glance. The same holds for names in business code:
topics are logical (`user-events`; the Pulsar adapter maps them to
`persistent://public/default/<topic>`), subscriptions and constants carry no
technology.

The kind suffix says what the file implements:

- `.adapter.ts` implements the port directly (`pulsar-messaging.adapter.ts`).
- `.engine.ts` / `.store.ts` implement the narrower technology interface
  behind a shared `<capability>.client.ts` (cache, graph, olap, search,
  vector). The client holds the rules every technology must follow, such as
  the tenant fence, key building and mapping guarantees, so they are written
  once and no engine can skip them.
- `.module.ts`, `.service.ts`, `.processor.ts`, `.health.ts` keep their Nest
  meaning.

| Capability   | Token        | Adapters                                                                                      |
| ------------ | ------------ | --------------------------------------------------------------------------------------------- |
| `documents`  | `DOCUMENTS`  | `mongoose` (plus `tenant-scope.ts`, the tenant fence for repositories, and `withTransaction`) |
| `relational` | `RELATIONAL` | `typeorm` (PostgreSQL, row-level security, verified TLS)                                      |
| `vector`     | `VECTOR`     | `pgvector`, `disabled`                                                                        |
| `graph`      | `GRAPH`      | `neo4j`, `disabled`                                                                           |
| `search`     | `SEARCH`     | `elasticsearch`, `disabled`                                                                   |
| `olap`       | `OLAP`       | `clickhouse`, `disabled`                                                                      |
| `objects`    | `OBJECTS`    | `minio`, `disabled`                                                                           |
| `cache`      | `CACHE`      | `redis`, `disabled`                                                                           |
| `kv`         | `KV`         | `redis`, `aerospike`, `disabled`                                                              |
| `lock`       | `LOCK`       | `redis`, `disabled`                                                                           |
| `ratelimit`  | `RATE_LIMIT` | `redis`, `disabled`                                                                           |
| `dedup`      | `DEDUP`      | `redis`, `disabled`                                                                           |
| `messaging`  | `MESSAGING`  | `pulsar`, `kafka`, `disabled` (plus `EventConsumer`, the consumer rules)                      |
| `jobs`       | `JOBS`       | `bullmq` (queue registry, `@JobHandler`, Bull Board, `DeadLetterJob`)                         |
| `workflow`   | `WORKFLOW`   | `temporal` (client, one worker per registered queue), `disabled`                              |
| `realtime`   | `REALTIME`   | `redis` (Socket.IO emitter + adapter), `local`                                                |
| `secrets`    | `SECRETS`    | `vault`, `env`                                                                                |
| `policy`     | `POLICY`     | `opa` (behind a circuit breaker)                                                              |
| `mail`       | `MAIL`       | `smtp`, `log`                                                                                 |
| `signing`    | `SIGNING`    | `inprocess`, `native` (the Rust signing service)                                              |

The adapter env vars and their defaults:
[development.md](development.md#environment-variables). Which technology owns
which job: [tech-decisions.md](tech-decisions.md).

Role-side modules (job workers, Bull Board, relay, outbox schedule, workflow
worker) sit next to their capability and are imported only by the role root
that runs them ([`src/roles/`](#srcroles--entry-points-and-role-roots)).

`rpc/` holds the RPC server plumbing: `RpcModule.forRoot()` with `RpcServer`
(Connect, gRPC and gRPC-Web per listener; `rpc-listener.ts` serves HTTP/1.1 +
h2c on one port), `@RpcService`, `interceptors/` (metrics, correlation,
errors, authentication, tenant, audit, authorization), `rpc-authz.service.ts`
(the verified caller for handlers), `rpc-errors.ts`, `rpc-cors.ts`,
`reflection.ts`, `standard-health.ts`.

Per-module RPC handlers live in each module's `controllers/`, not here.
`.proto` files live in `proto/` and are compiled into generated code under
`src/gen/` (`make proto`), so nothing reads a `.proto` at runtime;
internal-tier protos at `proto/<domain>/internal/v1/` are excluded from SDK
codegen ([api-conventions.md](api-conventions.md)).

Two behaviors to rely on:

- **Graceful degradation** — modules warn and continue when their backing service
  is down; the per-dependency behavior is in
  [tech-decisions.md → Degradation behavior](tech-decisions.md#degradation-behavior).
- **Queue policy** — retry and dead-letter behavior per queue:
  [architecture.md → Dead-letter handling](architecture.md#dead-letter-handling).

## `src/config/`

Joi env validation on startup (`env.validation.ts`), the CORS allow-list
(`cors.constants.ts`), the HTTP prefix (`http.constants.ts`) and the RPC
reflection gate (`grpc-reflection.ts`). Every env var the code reads is
declared in the Joi schema and `.env.example`, so a misconfigured deploy
fails at boot, not at first use; a value with a schema default is read with
`config.getOrThrow()`, so the default has one owner.

## Shared package (`packages/shared`)

`@tropis/shared` is a compiled TypeScript library imported by the backend and
the frontend. Code lives here only when both sides must agree on a contract,
or two backend units share an event contract (tier 3 of the placement rule).

```
packages/shared/src/
├── events/     event-types.ts (EVENT_TYPES, ANALYTICS_EVENT_TYPES),
│               user-events.ts (the user events topic and data types),
│               envelope.ts (CloudEvents envelope, event type rule),
│               tracking-events.ts (TRACKING_EVENTS — see tracking-plan.md)
├── errors/     catalog.ts (the error catalog: code, HTTP status, RPC code,
│               retryable, public message), problem.ts (RFC 9457 shape),
│               error-codes.ts (ERROR_CODES)
└── index.ts    barrel
```

CI builds shared before the backend and helm checks because their imports
resolve from its `dist/`.

## Frontend — helm (`apps/frontend/helm/src/`)

The frontend is split by audience: **helm** is the logged-in console
(React + Vite SPA, no SEO — crawlers are kept out by `public/robots.txt` (`Disallow: /`), and the analytics page also sets `<Seo noindex />`); **harbor** is
the public site ([below](#frontend--harbor-appsfrontendharbor)). SEO/rendering
split: [web-quality.md](web-quality.md).

Feature-first — the frontend mirror of the backend's module anatomy.

```
main.tsx           # entrypoint — the only file allowed to import app/
app/               # App shell: App.tsx (router, QueryClientProvider, sidebar nav +
│                  #   mobile top bar), ErrorBoundary, PageTracker, ThemeProvider
│                  #   (light default / dark / system), native-shell hooks
│                  #   (useNativeBackButton, useKeyboardAwareInputs)
features/          # one folder per domain feature: analytics, auth, behavior,
├── <feature>/     #   seo, stack, users, workflows
│   ├── components/  # feature-private components
│   ├── hooks/       # feature-specific hooks
│   ├── __tests__/   # feature specs
│   └── index.ts     # barrel — the feature's ONLY public surface
pages/             # Route-level views — THIN: compose features, no business logic
                   #   (AnalyticsPage, UsersPage, StackPage)
components/        # Shared *presentational* components used by 2+ features (Toasts)
├── ui/            # shadcn/ui primitives (badge, button, card, dialog, dropdown-menu,
│                  #   input, label, select, table) — copied-in, owned code restyled
│                  #   onto the design tokens in index.css (edit freely)
state/
├── zustand/       # Global client state (authStore, toastStore)
└── tanstack/      # Server-state cache: queryClient + query hooks — DEFAULT for API data
lib/               # SDK wiring: api.ts, tracking.ts, websocket.ts, env.ts, error.ts,
                   #   webVitals.ts, utils.ts (shadcn `cn`), forms.ts, i18n.ts
locales/           # en/common.json (default), zh/common.json
```

Only `index.ts` is mandatory in a feature; the subfolders appear when used.

`lib/error.ts` re-exports `parseApiError` from `@tropis/sdk`, which converts any
thrown value (RFC 9457 problem, Connect error, network failure) into one
`ApiError`: catalog `code`, safe `message`, `status`, `retryable`,
`fieldErrors`, `traceId`, `isAuth`, `isNetwork`. Catch API errors through it rather than reading
`err.message`, so every screen shows the same error text.

### State management

| Where                | Pattern             | Use for                                      | Limitation                                        |
| -------------------- | ------------------- | -------------------------------------------- | ------------------------------------------------- |
| component `useState` | Local state         | Form state, UI toggles, component-local data | Lost on unmount; no sharing without prop-drilling |
| `state/zustand/`     | Global client store | Auth session, toasts, UI globals             | Manual invalidation; no background refetch        |
| `state/tanstack/`    | TanStack Query      | Any server data                              | Overkill for purely local UI state                |

`queryClient.ts` defaults: `staleTime` 30 s, `gcTime` 5 min, `retry` 2,
`refetchOnWindowFocus: true`; mutations do not retry. Never mirror server data
into Zustand — two caches of the same data disagree.

### `@tropis/sdk` client

All backend calls go through `@tropis/sdk` (`packages/sdk`), wired up once in
`src/lib/api.ts`. Connect RPC is the default transport; REST is used only for the
approved cases ([api-conventions.md](api-conventions.md)).

```
Browser → NestJS :50051 (Connect protocol, binary protobuf over HTTP/1.1 or HTTP/2, no proxy)
```

| `packages/sdk/src/`  | Content                                                           |
| -------------------- | ----------------------------------------------------------------- |
| `gen/`               | buf-generated proto types (`make proto`)                          |
| `client/`            | Connect RPC transport and typed service clients                   |
| `rest/`              | REST helpers                                                      |
| `realtime/`          | Socket.io realtime client                                         |
| `tracking/`          | Tracking SDK — batches events, flushes via `navigator.sendBeacon` |
| `signing/`           | Request signing                                                   |
| `auth/`, `errors/`   | Token handling, typed errors                                      |
| `api.ts`, `index.ts` | `createApi` facade and exports                                    |

### Forms convention (react-hook-form + zod)

Forms use `useZodForm(schema)` from `src/lib/forms.ts`; reference:
`features/auth/components/LoginForm.tsx`. Why this pairing and the
accessible-error pattern:
[tech-decisions.md → react-hook-form + zod](tech-decisions.md#react-hook-form--zod-forms).

### Images

Every `<img>` gets `loading="lazy"`, explicit `width`/`height` (prevents layout
shift), and meaningful `alt` text (translated via i18n where user-facing). The
only images are user avatars in `features/users/components/UserTable.tsx`
(32×32), served from MinIO presigned URLs at original size; image choices are
in [tech-decisions.md](tech-decisions.md).

### Placement rules (frontend mirror of the backend three-tier rule)

| Tier | Location                      | When                                          |
| ---- | ----------------------------- | --------------------------------------------- |
| 1    | `features/<name>/components/` | Component used by exactly one feature         |
| 2    | `src/components/`             | Presentational component used by 2+ features  |
| 3    | `packages/`                   | Shared with other apps (SDK/shared contracts) |

### One-way dependency rules

Config: `apps/frontend/helm/.dependency-cruiser.cjs`; `pnpm lint:arch`, run in
the frontend CI job after Lint. All `error` severity; the only carve-out is
`src/lib/utils.ts` in `shared-components-are-presentational`.

- `no-circular` — no runtime dependency cycles anywhere.
- `only-main-imports-app` — `app/` is the composition root; only `main.tsx` imports it.
- `features-not-into-pages-or-app` — pages compose features, never the reverse.
- `no-cross-feature-imports` — features are independent verticals; shared UI is promoted to `src/components/`, shared logic to `lib/`/`state/`.
- `feature-internals-are-private` — everything outside a feature imports it via its `index.ts` barrel.
- `shared-components-are-presentational` — `src/components/` may not import features, pages, state, lib or app (props only). Sole exception: `src/lib/utils.ts` (the shadcn `cn` helper, a pure function).
- `state-not-into-ui` — state hooks/stores may wrap `lib/` API calls but never import components/features/pages/app.
- `lib-is-a-leaf` — `lib/` depends only on `packages/` (`@tropis/sdk`, `@tropis/shared`), never on any `src/` layer.

## Frontend — harbor (`apps/frontend/harbor/`)

The public site — Next.js App Router. Same layering as helm, adapted for Next.
Config: `apps/frontend/harbor/.dependency-cruiser.cjs`; `pnpm lint:arch` in CI.

```
app/           # ROUTES ONLY — pages, layouts, route handlers, metadata.
  layout.tsx   #   site-wide <html>/<body> + default SEO metadata
  page.tsx     #   a route (React Server Component); exports its own `metadata`
  pricing/     #   nested route (pricing/page.tsx)
  robots.ts, sitemap.ts
features/      # one folder per domain feature, public surface via index.ts
               #   (holds only its README; no feature yet)
components/    # shared presentational components (props only); primitives go in
               #   components/ui/
lib/           # leaf: site.ts (site config)
```

harbor does not depend on `@tropis/sdk`; a feature that needs backend data adds
it and wires the calls in `lib/`.

**One-way dependency rules** (`error` severity):

- `no-circular` — no runtime dependency cycles.
- `nothing-imports-routes` / `features-not-into-app` — `app/` is the root;
  `features/`, `components/` and `lib/` never import it. (Colocating components
  inside a route folder is fine.)
- `no-cross-feature-imports` — features are independent verticals. Shared UI →
  `components/`; shared logic/config → `lib/`.
- `feature-internals-are-private` — import a feature only through its `index.ts`.
- `shared-components-are-presentational` — `components/` imports nothing from
  `app/`/`features/`/`lib/` (except `lib/utils.ts`).
- `lib-is-a-leaf` — `lib/` imports nothing from `app/`/`features/`/`components/`.

**SEO is server-native** (Next Metadata API, `app/robots.ts`, `app/sitemap.ts`);
see [web-quality.md](web-quality.md). Rendering: SSG by default per route,
SSR/`dynamic` only where a page must be personalised.

## Desktop and mobile shells

The native shells are **shells, not apps**. All features live in
`apps/frontend/helm` (rendered identically in browser, mobile and desktop); the
shells only package that build and expose native capabilities. Build steps:
[deployment.md](deployment.md).

```
apps/desktop/                 # Tauri v2 (full rules in apps/desktop/README.md)
├── package.json              # only the Tauri CLI
└── src-tauri/
    ├── tauri.conf.json       # window/bundle config, identifier; frontendDist =
    │                         #   apps/frontend/helm/dist; beforeBuildCommand builds helm
    ├── capabilities/         # deny-by-default permission grants — review like OPA policies
    ├── src/lib.rs            # builder wiring; native #[tauri::command]s go here
    ├── src/main.rs
    └── icons/                # generated set (`pnpm tauri icon <1024px.png>`)

apps/frontend/helm/android/        # Capacitor Gradle project (build outputs ignored)
apps/frontend/helm/ios/            # Capacitor Xcode project (Pods ignored)
apps/frontend/helm/capacitor.config.ts
```

Hard rules:

1. **Zero business logic in any shell.** If it can be done in the web app, it
   must be done in the web app — otherwise behavior forks per platform.
2. Native commands only for what the web platform can't do (fs dialogs, tray,
   global shortcuts); each one needs the narrowest capability entry.
3. Shells consume the frontend build as-is — API endpoints come from the
   frontend's `VITE_*` env at build time.

## Naming conventions

- **Files**: kebab-case with a type suffix — `user.service.ts`,
  `create-user.dto.ts`, `event-log.schema.ts`, `analytics.constants.ts`.
- **Classes**: PascalCase — `UserService`, `CreateUserDto`.
- **Barrels**: every helm/harbor feature exposes an `index.ts`, and everything
  outside the feature imports from it, not deep paths. Backend modules are
  imported by file path; NestJS module boundaries are expressed through
  `exports` in `*.module.ts`, and a backend feature reaches a foundation
  module only through its public surface
  ([Foundation and features](#foundation-and-features)).
