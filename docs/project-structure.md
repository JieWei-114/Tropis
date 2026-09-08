# Project Structure

Where everything goes, and why. This describes both the **current code** and the **agreed standard** for new code — differences are called out honestly at the end.

## Monorepo layout

```
apps/backend/          NestJS API (gRPC + REST + WS)
apps/frontend/helm/         Admin console — React + Vite SPA (backend console, CSR, noindex)
apps/frontend/harbor/       Public site — Next.js App Router (public frontend, SSR/SSG, full SEO)
apps/temporal-worker/  Legacy standalone worker (unused; the live worker runs in-process:
                       apps/backend/src/infrastructure/temporal/temporal-worker.module.ts)
packages/shared/       Cross-app types, DTOs, event contracts
packages/sdk/          TypeScript client SDK (gRPC-Web client, REST, realtime, tracking, request signing; generated types in src/gen/)
e2e/                   Playwright browser E2E suite (@tropis/e2e)
devtools/              Local CLI dev tools that poke the running stack (@tropis/devtools — see devtools/README.md)
services/              Polyglot (non-Node) services — one folder per service (see below)
flink/                 Java stream jobs
infra/                 docker-compose, k8s, envoy, otel, prometheus, opa, vault, …
docs/                  You are here
```

## `services/` — polyglot services

Non-Node services live here, **one folder per service**, each with its own
toolchain (Cargo, Go modules, …), Dockerfile, README, and tests — they are NOT
pnpm workspace packages. The contract with the rest of the system is always a
proto in `proto/` (buf-linted, `buf breaking`-gated), transported over gRPC or
Pulsar; nothing imports across the language boundary. When to add one (almost
never — profile first): [tech-decisions.md → Rust vs TypeScript](tech-decisions.md#rust-vs-typescript).
The full how-to (add-a-service checklist, standard-citizen requirements,
naming) is in [services/README.md](../services/README.md).

`services/` is organised **per language**: `services/<lang>/` holds the
language's shared toolchain config, and each subfolder inside it is an
independently deployable **service** (own Dockerfile, own compose entry) —
NOT a module of one app. For Rust, the language folder is the **Cargo
workspace** root: `services/rust/Cargo.toml` carries shared dependency
versions (`[workspace.dependencies]`), one `services/rust/rustfmt.toml`, a
single `Cargo.lock` and `target/` at `services/rust/`. A future `services/go/`
would follow the same pattern with a `go.work`. Each service keeps its **own
Dockerfile** (a service is the deployable unit — it builds, deploys, and
scales independently; the image builds only its crate via
`cargo build --release -p <crate>`).

- `services/rust/signing/` — Rust gRPC service computing/verifying HMAC request
  signatures (`tropis.signing.v1`, contract `proto/signing/v1/signing.proto`);
  the reference implementation for the pattern.

## Rust service anatomy (`services/rust/`)

Every Rust service under `services/rust/<name>/` follows this layout — the
polyglot mirror of the backend module anatomy. **Copy `services/rust/signing/`
as the template for a new Rust service.**

```
services/rust/Cargo.toml      # Workspace root: members, shared dep versions, release profile
services/rust/rustfmt.toml    # Workspace-level formatting (anchor for `cargo fmt --check`)
services/rust/Cargo.lock      # Single lockfile (single target/ too — gitignored)
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
│   │                        # — ONE place maps domain errors → transport codes,
│   │                        # mirrors the backend's exception filters.
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

### One-way rule — enforced by the compiler

```
grpc/  →  domain/  →  infra/ (via traits)
```

Unlike the TS apps (dependency-cruiser), this is **compiler-enforced**:

- Everything in `domain/` is `pub(crate)` (declared in `lib.rs`); domain types
  can never appear in the crate's public API, so a transport handler exposing
  a domain type in a `pub` signature fails to compile (E0446).
- `domain/` imports no tonic/prost types — the proto structs are decoded into
  plain domain structs at the `grpc/` boundary, so the transport can be
  swapped without touching business logic. CI greps
  `src/domain/` for `use tonic`/`use prost` as a belt-and-braces check.
- `main.rs` is a separate bin crate consuming the lib: it can only reach the
  `pub` surface (`config`, `grpc`, `pb`) — it physically cannot call domain
  logic directly. The same applies to `tests/`, which forces integration
  tests through the real transport.

### Naming convention

- Folder: `services/<lang>/<name>` (`services/rust/signing`; a Go port would
  be `services/go/signing`) — the service folder is the plain domain name, no
  language suffix needed since the parent folder carries it.
- Proto package, service name, and runtime artifacts stay **language-neutral**:
  package `tropis.signing.v1`, crate/binary `signing`, compose service `signing`
  — the language appears only in the source path, so reimplementing a
  service in another language changes no contracts or deployment names.
- Rust files: snake_case, one feature per file inside each layer
  (`domain/signature.rs`, `grpc/signing.rs`).

### Hard rules (Rust mirror of the backend hard rules)

1. `main.rs` is bootstrap only — config, tracing, server wiring, shutdown.
2. `grpc/` handlers are thin — decode, delegate, encode. Reason strings and
   error codes come from `domain/`/`error.rs`, never inline.
3. `domain/` is pure and unit-tested; anything doing IO belongs in `infra/`
   behind a trait.
4. Error → status mapping happens only in `error.rs`.
5. Verify from the workspace root `services/rust/` with `cargo fmt --check`,
   `cargo clippy --workspace --all-targets -- -D warnings`, and
   `cargo test --workspace` (unit + integration).

## Backend feature module anatomy (the standard)

Every new feature module under `apps/backend/src/modules/<feature>/` follows this layout:

```
modules/feature/
├── feature.module.ts        # NestJS module wiring — imports, providers, exports
├── controllers/             # REST + gRPC handlers. THIN. No business logic —
│                            # parse input, call a service, return a DTO.
├── services/                # ALL business logic lives here. Nothing else's job.
├── repositories/            # The ONLY place that touches ORM/drivers
│                            # (Mongoose models, TypeORM repos, Redis client…).
├── schemas/                 # Mongoose schemas / TypeORM entities.
│                            # NEVER returned directly from an API.
├── processors/              # BullMQ workers + Pulsar/EventBus subscribers.
│                            # Thin like controllers — delegate to services.
├── dto/                     # Input validation (class-validator) + response shapes.
├── transformers/            # entity → dto/proto mapping. Strips internal fields
│                            # (_id, __v, passwordHash…). The only door out.
├── interfaces/              # Module-internal TypeScript types.
├── constants/               # Queue names, cache key prefixes, event names,
│                            # error codes, module enums. NO magic strings in code.
├── utils/                   # Module-only pure functions. Zero DI, zero IO.
│                            # Must be unit-tested.
└── __tests__/               # Unit tests for the module.
```

### Hard rules

1. **One-way dependency flow, no layer-skipping:**

   ```
   controllers/ , processors/  →  services/  →  repositories/  →  schemas/
   ```

   A controller never imports a repository. A service never imports a Mongoose model directly. If you need data, ask the layer below you.

2. **Schemas never cross the API boundary.** Every response goes through a transformer.

3. **No magic strings.** Queue names, event names, cache keys, error codes → `constants/`.

4. **utils/ are pure.** If it needs injection or does IO, it's a service.

> **CI-enforced.** Rules 1–2 (plus cross-module boundaries, the infrastructure-only
> driver rule, and no circular dependencies) are checked by dependency-cruiser —
> config at `apps/backend/.dependency-cruiser.cjs`, run locally with
> `pnpm --filter @tropis/backend lint:arch`. Type-only driver imports
> (`import type Redis from 'ioredis'`) are allowed anywhere; runtime driver imports
> are restricted to `src/infrastructure/`. Known legacy exceptions are carved out
> in the config with `TODO` comments.

### Three-tier placement rule (enums / types / utils / constants)

> **Start at the smallest scope; promote when a second consumer appears.**

| Tier | Where                                                   | When                                                                     |
| ---- | ------------------------------------------------------- | ------------------------------------------------------------------------ |
| 1    | `modules/<feature>/constants/`, `interfaces/`, `utils/` | Used by a single module                                                  |
| 2    | `apps/backend/src/common/`                              | Used by 2+ backend modules                                               |
| 3    | `packages/shared/src/`                                  | Shared with frontend / SDK / Flink (e.g. event contracts, `ERROR_CODES`) |

Never put something in `packages/shared` "just in case" — promote on the second real consumer.

## `src/common/` layout

Cross-module backend concerns:

```
common/
├── guards/            # signature.guard + api-key.service + throttler-behind-proxy
│                      #   (auth guard lives in modules/auth/; role checks go through
│                      #   infrastructure/opa/, not a guard)
├── filters/           # http-exception.filter + grpc-exception.filter —
│                      #   both map to the unified error-code table in
│                      #   packages/shared/src/errors/
├── interceptors/      # audit (writes to modules/audit/) — no response-transform interceptor
├── middleware/        # correlation-id middleware
├── decorators/        # @CurrentUser(), @Audited(), @Public(), @RequireSignature()
├── tenant/            # tenant context + middleware + module
├── circuit-breaker/
└── feature-flags/
```

`pipes/`, `enums/`, `types/`, `utils/` are part of the standard but are created only when the first tier-2 consumer lands (none exists today).

## `src/infrastructure/` — one module per external system

Each external system gets exactly one NestJS module that owns its client/driver, under `src/infrastructure/`: `database/` (Mongo root connection), `redis/`, `pulsar/` (client lifecycle), `messaging/` (broker-agnostic `MessageBrokerPort` + Pulsar adapter — business code injects `MESSAGE_BROKER`, not the Pulsar client), `clickhouse/`, `postgres/`, `aerospike/`, `elasticsearch/`, `storage/` (MinIO), `vault/`, `opa/`, `temporal/`, `outbox/` (cross-cutting outbox relay), `queue/` (BullMQ root + queue producer/processors + bull-board), and `grpc/` (proto server plumbing: `grpc.module.ts` wiring, `grpc-health.service.ts`, `grpc-tenant.interceptor.ts`, `grpc-error.interceptor.ts` (domain errors → gRPC status codes), `grpc-authz.service.ts` (OPA authorization for gRPC handlers), `grpc.utils.ts` metadata helpers — per-feature gRPC handlers live in each module's `controllers/`). **Business code never imports drivers directly** — it injects the infrastructure module's service. This is what makes swapping/mocking a datastore a one-module change.

## `src/config/`

Typed config namespaces (`app.config.ts`) + Joi env validation on startup (`env.validation.ts`). New env vars must be added to the Joi schema and `.env.example`.

## Frontend layout (`apps/frontend/helm/src/`)

> The frontend is split by audience: **helm** (this section) is the logged-in
> admin console (React + Vite SPA, no SEO — mark public-looking routes
> `noindex`); **harbor** (`apps/frontend/harbor/`) is the public marketing/content
> site (Next.js App Router, SSR/SSG, full SEO) with its own layered convention —
> see [**Harbor layout**](#harbor-layout-appsfrontendharbor) below. SEO/rendering
> split: [web-quality.md](web-quality.md).

Feature-first — the frontend mirror of the backend's module anatomy. **CI-enforced** by dependency-cruiser (`apps/frontend/helm/.dependency-cruiser.cjs`, `pnpm lint:arch`, runs in the frontend CI job right after Lint).

```
main.tsx           # entrypoint — the only file allowed to import app/
app/               # App shell: router (App.tsx), providers (QueryClientProvider),
│                  # ErrorBoundary, PageTracker, ThemeProvider (light default / dark /
│                  # system), sidebar nav + mobile top bar
features/          # ⭐ one folder per domain feature (mirrors backend modules/)
├── <feature>/     # e.g. users, analytics, auth, behavior, stack — see the folder for the current set
│   ├── components/  # feature-private components
│   ├── hooks/       # feature-specific hooks
│   ├── __tests__/   # feature specs (backend convention)
│   └── index.ts     # barrel — the feature's ONLY public surface
pages/             # Route-level views — THIN: compose features, no business logic
components/        # Shared *presentational* components used by 2+ features (Toasts)
├── ui/            # shadcn/ui primitives (button, dialog, input, table, card, …) —
│                  # copied-in, owned code restyled onto the design tokens in index.css
│                  # (not an npm dependency; edit freely)
state/
├── local/         # useState/useEffect hooks — ephemeral UI state
├── zustand/       # Global client state (auth, toasts)
└── tanstack/      # Server-state cache (queries/mutations) — DEFAULT for API data
lib/               # SDK wiring: api.ts, tracking.ts, websocket.ts, env.ts, error.ts
                   # + utils.ts (shadcn `cn` helper), forms.ts (form convention)
                   # and i18n.ts (react-i18next init — see tech-decisions.md)
locales/           # Translation resources: en/common.json (default), zh/common.json
```

### Forms convention (react-hook-form + zod)

Forms use **react-hook-form** with a **zod** schema as the single source of
truth for validation (mirroring backend DTO validation). Wire up via
`useZodForm(schema)` from `src/lib/forms.ts`; render field errors inline with
`aria-invalid` on the input and the error text linked via `aria-describedby`.
Reference implementations: `features/auth/components/LoginForm.tsx` and
`features/users/components/UserModal.tsx`.

### Images

Every `<img>` gets `loading="lazy"`, explicit `width`/`height` (prevents
layout shift), and meaningful `alt` text (translated via i18n where
user-facing). The only real images today are user avatars in
`features/users/components/UserTable.tsx` — served straight from MinIO
presigned URLs at original size; server-side thumbnailing (sharp in the
backend upload path, or a resize worker off the `file-processing` queue) is
**backlog** — do it before avatars appear anywhere larger than the 32px table
cell.

### Placement rules (frontend mirror of the backend three-tier rule)

| Tier | Location                      | When                                          |
| ---- | ----------------------------- | --------------------------------------------- |
| 1    | `features/<name>/components/` | Component used by exactly one feature         |
| 2    | `src/components/`             | Presentational component used by 2+ features  |
| 3    | `packages/`                   | Shared with other apps (SDK/shared contracts) |

### One-way dependency rules (dependency-cruiser, `error` severity)

- `no-circular` — no runtime dependency cycles anywhere.
- `only-main-imports-app` — `app/` is the composition root; only `main.tsx` imports it.
- `features-not-into-pages-or-app` — pages compose features, never the reverse.
- `no-cross-feature-imports` — features are independent verticals; shared UI is promoted to `src/components/`, shared logic to `lib/`/`state/`.
- `feature-internals-are-private` — everything outside a feature imports it via its `index.ts` barrel.
- `shared-components-are-presentational` — `src/components/` may not import features, pages, state, lib or app (props only). Sole exception: `src/lib/utils.ts` (the shadcn `cn` class-name helper, a pure function).
- `state-not-into-ui` — state hooks/stores may wrap `lib/` API calls but never import components/features/pages/app.
- `lib-is-a-leaf` — `lib/` depends only on `packages/` (`@tropis/sdk`, `@tropis/shared`), never on any `src/` layer.

State placement: server data → TanStack Query; global client state → Zustand; component-local → `useState`. Never mirror server data into Zustand.

## Harbor layout (`apps/frontend/harbor/`)

The public site — Next.js App Router. Same layering philosophy as helm/backend,
adapted for Next. **CI-enforced** by dependency-cruiser
(`apps/frontend/harbor/.dependency-cruiser.cjs`, `pnpm lint:arch`).

```
app/           # ROUTES ONLY — pages, layouts, route handlers, metadata,
               #   robots.ts / sitemap.ts. The composition root Next loads.
  layout.tsx   #   site-wide <html>/<body> + default SEO metadata
  page.tsx     #   a route (React Server Component); exports its own `metadata`
  <route>/     #   nested route (e.g. pricing/page.tsx)
features/      # one folder per domain feature (pricing/, blog/, …); public
               #   surface via index.ts barrel; route-specific UI + data
components/    # shared PRESENTATIONAL components (props only); ui/ for primitives
lib/           # leaf: site config, @tropis/sdk data wiring, utils
```

**One-way dependency rules** (dependency-cruiser, `error` severity — mirror of helm):

- `nothing-imports-routes` / `features-not-into-app` — `app/` is the root; nothing
  outside it imports it, and features never import `app/`. (Colocating components
  inside a route folder is fine.)
- `no-cross-feature-imports` — features are independent verticals. Shared UI →
  `components/`; shared logic/config → `lib/`.
- `feature-internals-are-private` — import a feature only through its `index.ts`.
- `shared-components-are-presentational` — `components/` imports nothing from
  `app/`/`features/`/`lib/` (except `lib/utils.ts`).
- `lib-is-a-leaf` — `lib/` depends only on `packages/`.

**SEO is server-native** (Next Metadata API, `app/robots.ts`, `app/sitemap.ts`) —
no `<Seo>` component here; see [web-quality.md](web-quality.md). Rendering: SSG by
default per route, SSR/`dynamic` only where a page must be personalised.

## Desktop shell (`apps/desktop/`) and mobile shells

The native shells are **not apps — they are shells**. All features live in
`apps/frontend/helm` (rendered identically in browser, mobile, and desktop); the
shells only package that build and expose native capabilities.

```
apps/desktop/                 # Tauri v2 (see apps/desktop/README.md for full rules)
├── package.json              # only the Tauri CLI
└── src-tauri/
    ├── tauri.conf.json       # window/bundle config, identifier (replace before release)
    ├── capabilities/         # deny-by-default permission grants — review like OPA policies
    ├── src/lib.rs            # builder wiring; native #[tauri::command]s go here
    │                         #   (extract to src/commands/ beyond ~2 commands)
    └── icons/                # generated set (`pnpm tauri icon <1024px.png>`)

apps/frontend/helm/android/        # Capacitor Gradle project (committed; build outputs ignored)
apps/frontend/helm/ios/            # Capacitor Xcode project (committed; Pods ignored)
apps/frontend/helm/capacitor.config.ts
```

Hard rules:

1. **Zero business logic in any shell.** If it can be done in the web app, it
   must be done in the web app.
2. Native commands only for what the web platform can't do (fs dialogs, tray,
   global shortcuts); each one needs the narrowest capability entry.
3. Shells consume the frontend build as-is — API endpoints come from the
   frontend's `VITE_*` env at build time (`docs/multi-platform.md`).

## Naming conventions

- **Files**: kebab-case with a type suffix — `user.service.ts`, `create-user.dto.ts`, `event-log.schema.ts`, `analytics.constants.ts`.
- **Classes**: PascalCase — `UserService`, `CreateUserDto`.
- **Barrel exports**: each folder exposes an `index.ts`; import from the folder, not deep paths.

## Current state vs target (honest notes)

The structural refactor to this standard is **done**: `user`, `analytics`, `auth`, `tracking`, `notification`, and `websocket` follow the module anatomy above; per-feature gRPC handlers live in each module's `controllers/` (`*.grpc.controller.ts`); infrastructure modules live under `src/infrastructure/`; specs live in `__tests__/`; the unified error-code table exists at `packages/shared/src/errors/error-codes.ts` and both exception filters consume it via `@tropis/shared`.

Deliberate deviations:

- `modules/health/`, `modules/metrics/` and `modules/workflows/` stay **flat** (`health.module.ts` + `health.controller.ts` + `indicators/`; `metrics.module.ts` + `metrics.controller.ts`; `workflows.module.ts` + `workflows.controller.ts`) — they are thin, logic-free modules and the full anatomy would be empty folders.
- `modules/audit/` is deliberately slim (`audit.module.ts` + `services/` + `constants/` + `interfaces/` + `__tests__/`) — its entry point is the cross-cutting `AuditInterceptor` in `common/interceptors/` driven by the `@Audited()` decorator, so it has no controllers/repositories of its own.
- `modules/user/` additionally keeps its CQRS folders (`commands/`, `queries/`, `events/`, `event-store/`) alongside the standard anatomy.
- The websocket gateway is its own `modules/websocket/` (with `gateways/`) rather than folded into `modules/notification/`, matching the existing module boundary (`NotificationModule` = email sender, `WebsocketModule` = realtime push).
- BullMQ processors (`notification`, `file-processing`, `dlq`) remain in `infrastructure/queue/` with the queue root and bull-board wiring; they should migrate into their owning modules' `processors/` when those modules take ownership.
- `.proto` files stay in `proto/` (referenced from `main.ts` relative to the build output). Internal-tier protos live at `proto/<domain>/internal/v1/` and are excluded from SDK codegen (see docs/api-conventions.md).
