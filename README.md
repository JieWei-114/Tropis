# Tropis

Tropis (τρόπις) — the keel. The foundation every product is built on.

Full-stack learning monorepo — every major technology wired together into one runnable system.

---

## Documentation

| Doc                                                                                  | What's in it                                                                                                                                                                                                        |
| ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [docs/architecture.md](docs/architecture.md)                                         | Components, data flow, transport strategy, event pipeline, observability                                                                                                                                            |
| [docs/tech-decisions.md](docs/tech-decisions.md)                                     | **The core doc** — when to use each technology (and when not to), with decision tables                                                                                                                              |
| [docs/project-structure.md](docs/project-structure.md)                               | Where code goes: module anatomy, layering rules, three-tier placement, naming                                                                                                                                       |
| [docs/testing.md](docs/testing.md)                                                   | Test pyramid, regression strategy, coverage philosophy                                                                                                                                                              |
| [docs/api-versioning.md](docs/api-versioning.md)                                     | gRPC/REST/event versioning and compatibility rules                                                                                                                                                                  |
| [docs/api-conventions.md](docs/api-conventions.md)                                   | Public vs internal API tiers, HMAC request signing, crypto terminology, response envelope, param conventions                                                                                                        |
| [docs/deployment.md](docs/deployment.md)                                             | Laptop → production: local run (Compose), learning on local Kubernetes (`kind`), cost tiers, build/push, K8s deploy, GitOps (Argo CD), secrets/Vault, TLS, rollback, backups, component map + `kubectl` cheat sheet |
| [docs/adding-a-feature.md](docs/adding-a-feature.md)                                 | Step-by-step: create a new backend module end to end                                                                                                                                                                |
| [docs/git-workflow.md](docs/git-workflow.md)                                         | Issue → branch → commit → PR → release-please → tag → deploy: the full delivery chain                                                                                                                               |
| [docs/troubleshooting.md](docs/troubleshooting.md)                                   | Common local-dev issues and fixes                                                                                                                                                                                   |
| [docs/dev-tools.md](docs/dev-tools.md)                                               | "Poke anything locally" map: one line per technology → tool → how to open it                                                                                                                                        |
| [docs/tracking-plan.md](docs/tracking-plan.md)                                       | Tracking (埋点) event dictionary: naming convention, per-event registry, base props, A/B experiment convention                                                                                                      |
| [docs/security-checklist.md](docs/security-checklist.md)                             | Pre-launch security checklist                                                                                                                                                                                       |
| [docs/multi-platform.md](docs/multi-platform.md)                                     | PWA / Android (Capacitor) / iOS / desktop (Tauri): prerequisites, build commands, device env wiring, store submission                                                                                               |
| [docs/web-quality.md](docs/web-quality.md)                                           | SEO, Core Web Vitals, accessibility, security headers, PWA, AEO — the five Lighthouse dimensions, the `<Seo>` component, and the public-page checklist                                                              |
| [docs/workflow/](docs/workflow/README.md)                                            | Docs-before-code: per-feature PRD → proposal → contracts → decisions → acceptance report (templates included)                                                                                                       |
| [AGENTS.md](AGENTS.md)                                                               | AI coding agent guide: rules, verification commands, do/don'ts (Claude Code entry: [CLAUDE.md](CLAUDE.md))                                                                                                          |
| [CONTRIBUTING.md](CONTRIBUTING.md) · [SECURITY.md](SECURITY.md) · [LICENSE](LICENSE) | How to contribute, report vulnerabilities, MIT license                                                                                                                                                              |

## Quickstart

### Prerequisites

| Tool                              | Version                                                        | Install                                                                           |
| --------------------------------- | -------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| **Docker Desktop**                | recent, with **8 GB+** memory allocated (Settings → Resources) | docker.com                                                                        |
| **Node.js**                       | **≥ 22** (`.nvmrc` provided)                                   | `nvm install 22 && nvm use`                                                       |
| **pnpm**                          | 10                                                             | `corepack enable` (ships with Node)                                               |
| Rust (optional)                   | stable                                                         | `rustup` — only for `services/rust/` and the desktop app                          |
| Android Studio / Xcode (optional) | —                                                              | only for the mobile shells — see [docs/multi-platform.md](docs/multi-platform.md) |

### First run (zero → logged in, ~10 minutes)

```bash
git clone <this-repo> && cd <repo>
nvm use              # picks up .nvmrc (Node 22)
make install         # pnpm install + creates apps/backend/.env + apps/frontend/helm/.env from the examples
make up              # starts the core containers (first run pulls images — a few minutes)
make dev             # backend (:3100 REST / :50051 gRPC) + frontend (:5173) + temporal worker, watch mode
# in a second terminal, once `make dev` is up:
make seed            # admin + demo users + sample analytics events
```

**First success check:** open http://localhost:5173 → log in with
`admin@example.com` / `Password123!` → you should see the Analytics dashboard;
the Users tab lists the seeded users. Something failing? →
[docs/troubleshooting.md](docs/troubleshooting.md).

**Where to go next:** [docs/architecture.md](docs/architecture.md) (what you just
started) → [docs/tech-decisions.md](docs/tech-decisions.md) (why each piece exists) →
[docs/adding-a-feature.md](docs/adding-a-feature.md) (build something).

### Daily commands

```bash
make dev       # start everything in watch mode
make test      # unit tests across the workspace
make down      # stop all containers
make help      # every target, self-documented
```

### Docker compose profiles

Core services (no profile) are everything the backend health check probes, so `make up` alone
supports `make dev`, login and the users page. Optional groups live behind compose profiles:

| Command                                                                  | Profile                                        | What it starts                                                                                                                                                                          | Background reading                                                                                                  |
| ------------------------------------------------------------------------ | ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `make up`                                                                | _(core, default)_                              | every datastore, broker, and infra dependency the backend health check probes                                                                                                           | [docs/tech-decisions.md](docs/tech-decisions.md) — Redis vs Aerospike, Pulsar, ClickHouse, Vault, OPA, MinIO, Envoy |
| `make up-analytics`                                                      | `analytics`                                    | Flink stream-processing cluster                                                                                                                                                         | TECH-DECISIONS → Flink                                                                                              |
| `make up-obs`                                                            | `observability`                                | tracing + metrics pipeline (collector, trace UI, metrics, alerting, dashboards)                                                                                                         | [docs/architecture.md](docs/architecture.md) (tracing/metrics pipeline)                                             |
| `docker compose -f infra/docker/docker-compose.yml --profile rust up -d` | `rust`                                         | signing (Rust gRPC, :50052)                                                                                                                                                             | [services/rust/signing/README.md](services/rust/signing/README.md) · TECH-DECISIONS → Rust vs TypeScript            |
| `make up-tools`                                                          | `tools`                                        | web UIs for every datastore/broker (incl. grpcui at :8083 — a point-and-click gRPC client via server reflection) — see [docs/dev-tools.md](docs/dev-tools.md) for the full list + ports | [docs/dev-tools.md](docs/dev-tools.md)                                                                              |
| `make up-all`                                                            | core + `analytics` + `observability` + `tools` | full stack (needs ~8GB+ Docker memory; `rust` profile started separately)                                                                                                               | —                                                                                                                   |

## API strategy

**gRPC-first**: every business operation is a gRPC method (`proto/`), consumed by the browser via gRPC-Web through Envoy. **REST (`/api/v1`) fills the gaps only** — file uploads, OAuth callbacks, webhooks, health/metrics, SSE. **WebSocket (Socket.io)** handles realtime notifications. Details in [docs/architecture.md](docs/architecture.md).

---

## Repository structure

The stable skeleton — what each area is FOR. The authoritative "what goes
where" rules (module anatomy, layering, placement) live in
[docs/project-structure.md](docs/project-structure.md); for the current
contents of any area, look at the directory itself.

```
.
├── apps/                  Runnable TS-family applications (pnpm workspace)
│   ├── backend/           NestJS API — gRPC-first + REST + WS
│   │   └── src/           modules/ (features) · infrastructure/ (external systems)
│   │                      · common/ (cross-cutting) · config/
│   ├── frontend/          Split into two web apps:
│   │   ├── helm/          React + Vite + Tailwind/shadcn admin PWA (CSR SPA)
│   │   │   └── src/       app/ (shell) · features/ · pages/ · components/
│   │   │                  · state/ (local|zustand|tanstack) · lib/ · locales/
│   │   └── harbor/        Next.js 15 App Router public site (SSR/SSG/SEO)
│   │       └── app/       features/ · components/ · lib/ (CI-enforced structure)
│   ├── desktop/           Tauri desktop shell (zero business logic)
│   └── temporal-worker/   Temporal workflows + activities
├── packages/              Importable libraries shared across apps
│   ├── shared/            Cross-app types, error codes, event contracts
│   └── sdk/               @tropis/sdk — typed client (gRPC-Web, REST, realtime,
│                          tracking, signing; generated types in src/gen/)
├── proto/                 ⭐ The contracts — <domain>/v1/*.proto, buf-governed,
│                          language-neutral source of truth for every API
├── services/              Polyglot deployable services — services/<lang>/<name>,
│                          plug in via proto/ only (rust/ = Cargo workspace)
├── flink/                 Java stream-processing jobs
├── e2e/                   Playwright browser E2E (black-box, full stack)
├── load/                  k6 load tests (black-box, performance)
├── devtools/              Local CLI dev tools that poke the running stack
│                          (@tropis/devtools — ws-listen, outbox-status, sdk-repl)
├── infra/                 docker-compose, k8s (base + overlays), envoy, otel,
│                          prometheus/grafana, vault, opa, argocd, backup
├── docs/                  Explanations & decisions (start: tech-decisions.md)
│   └── workflow/          Per-feature working docs (PRD → proposal → decisions)
├── .github/               CI workflows, issue/PR templates, release automation
├── Makefile               Developer entrypoints — `make help`
└── buf.yaml               Proto lint/breaking-change gate + SDK codegen
```

## Tech stack

A curated what-and-why per layer — the WHY behind each choice (and its
alternatives) lives in [docs/tech-decisions.md](docs/tech-decisions.md); the
exhaustive dependency list is `package.json` / `pnpm-lock.yaml`.

| Layer                        | Choice                                                                                                                                                 | Why                                                                                                                                                               |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Frontend — helm** (后台)   | React 18 + Vite + Tailwind v4/shadcn, TanStack Query + Zustand, react-hook-form + zod, i18next (en/zh), PWA                                            | The logged-in **admin console** (CSR SPA, `noindex`); also wrapped by the mobile (Capacitor) and desktop (Tauri) shells. Conventions in docs/project-structure.md |
| **Frontend — harbor** (前台) | Next.js 15 (App Router, SSR/SSG)                                                                                                                       | The public **marketing/content site** — full SEO (Metadata API, `robots.ts`/`sitemap.ts`). Split rationale: docs/web-quality.md                                   |
| **Backend**                  | NestJS 11 (TypeScript), gRPC-first + REST gap-fillers + Socket.io                                                                                      | Layered modules, DI, first-class gRPC/microservice support                                                                                                        |
| **Contracts**                | Protocol Buffers governed by buf                                                                                                                       | Language-neutral single source of truth; breaking-change gate in CI                                                                                               |
| **Data**                     | MongoDB (documents/event store/outbox), PostgreSQL + pgvector, Redis, Aerospike (sessions), Elasticsearch (search), ClickHouse (OLAP), MinIO (objects) | Each store picked by access pattern — decision tables below                                                                                                       |
| **Async**                    | Pulsar (events, behind MessageBrokerPort), BullMQ (jobs + DLQ), Temporal (durable workflows), Flink (stream processing)                                | Distinct roles: fact broadcast vs job vs saga vs stream                                                                                                           |
| **Reliability**              | Outbox, idempotency keys, circuit breaker, replay-safe handlers, feature flags                                                                         | See "Reliability patterns" below                                                                                                                                  |
| **Auth & policy**            | JWT + Passport (OAuth2 Google/GitHub), RBAC, OPA (Rego), multi-tenancy, Vault (secrets + Transit encryption)                                           | AuthN in-app, authZ externalized, secrets never in code                                                                                                           |
| **Observability**            | OpenTelemetry → Jaeger, Prometheus + Grafana, Pino JSON logs                                                                                           | Vendor-neutral pipeline — see the vendor swap matrix in tech-decisions.md                                                                                         |
| **Quality & supply chain**   | Jest/Vitest/Playwright/Testcontainers, ESLint+Prettier+Husky, Gitleaks, CodeQL, SonarCloud, Dependabot, Trivy/SBOM                                     | All CI-enforced — see `.github/workflows/ci.yml`                                                                                                                  |
| **Delivery**                 | Docker Compose (local), Kubernetes + kustomize, Argo CD (GitOps), release-please                                                                       | docs/deployment.md, docs/git-workflow.md                                                                                                                          |

---

## Technology decisions — what each piece is for

Every technology has one distinct role. Nothing is duplicated.

### Data storage

| Technology        | Type                     | Use this when…                                                                                                                                                                      |
| ----------------- | ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **MongoDB**       | Document store           | Data has flexible or nested structure. User profiles, analytics events, anything where the schema evolves. No joins needed.                                                         |
| **PostgreSQL**    | Relational DB            | Data has strict relationships, foreign keys, ACID transactions. Structured records you'd traditionally put in a relational DB.                                                      |
| **pgvector**      | Vector store (extension) | Semantic / similarity search on embedding vectors. Store a `vector(1536)` column alongside your relational data, run `<=>` cosine similarity queries. No separate vector DB needed. |
| **Elasticsearch** | Search engine            | Full-text search, fuzzy matching, faceted filters, ranked results. ClickHouse is for aggregations; Elasticsearch is for search bars and "did you mean?" queries.                    |
| **Redis**         | In-memory KV             | You need sub-millisecond reads. Cache hot objects (users, stats), BullMQ queue storage, session tokens, pub/sub. Data can be rebuilt if lost.                                       |
| **ClickHouse**    | Columnar OLAP            | You need to aggregate millions of rows fast — "logins in last 24 h", "top pages this week". Write-heavy, column-oriented. Not for single-row lookups.                               |
| **Aerospike**     | High-speed KV            | Redis-level speed but with SSD persistence and no memory cap. Session state for millions of concurrent users. Survives restarts without cache-warming.                              |
| **MinIO**         | Object storage           | Binary files — images, documents, exports, videos. API is 100% AWS S3 compatible. Swap `MINIO_ENDPOINT` to S3 in prod without changing a line of code.                              |

### Messaging & async

| Technology             | Type                        | Use this when…                                                                                                                                                                                                                                                                                                                                                                                      |
| ---------------------- | --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Apache Pulsar**      | Event streaming             | Services need to react to things without being coupled. `user.created` is published once; any number of consumers react independently. Durable — survives restarts.                                                                                                                                                                                                                                 |
| **BullMQ**             | Job queue                   | A specific job must run exactly once, reliably, with retries. Welcome email after signup, PDF generation, webhook delivery. Retries ×3 with exponential backoff. Backed by Redis.                                                                                                                                                                                                                   |
| **Apache Flink**       | Stream processing           | Continuous transformation of an infinite stream. Pulsar analytics topic → aggregate → ClickHouse micro-batches. Handles windowing, stateful joins, exactly-once semantics.                                                                                                                                                                                                                          |
| **Temporal**           | Workflow orchestration      | Durable, long-running multi-step workflows with automatic retries, timeouts, and full execution history. Use instead of BullMQ when a job spans multiple steps, can fail mid-way, or needs to wait for signals.                                                                                                                                                                                     |
| **CQRS**               | Write/read split            | Commands (writes) go through `CommandBus` → dedicated handlers that own all business logic. Queries (reads) go through `QueryBus` → read directly from Redis cache or MongoDB. Separates mutation logic from read logic — handlers are independently testable.                                                                                                                                      |
| **Event Sourcing**     | Audit / history             | Every write appends an immutable event to `user_event_store` in MongoDB. State at any point in time can be rebuilt by replaying events from version 1 upward. Pairs with CQRS — the command handler appends, the query handler reads the current state.                                                                                                                                             |
| **OPA**                | Externalised policy         | Role-to-action permissions defined in Rego (`infra/opa/authz.rego`). NestJS asks OPA's REST API `POST /v1/data/authz/allow` on every mutating gRPC call. Policy changes don't require a code deploy. OPA calls are wrapped in a circuit breaker — 5 consecutive failures open the circuit for 30 s (fail-fast, deny by default).                                                                    |
| **RBAC**               | Role-based access           | Three roles: `admin` (full access), `editor` (read + write, no delete), `viewer` (read only). Roles embedded in JWT. `RolesGuard` enforces roles on HTTP routes; `OpaGuard` enforces them on gRPC via OPA.                                                                                                                                                                                          |
| **Outbox**             | Guaranteed event delivery   | Both user and analytics writes use the outbox pattern. Each write wraps the business document + outbox row in a single MongoDB transaction. A relay polls PENDING rows every 5 s and publishes to Pulsar (multi-topic: `user-events` and `analytics-events`). If Pulsar is down, the relay retries until it succeeds. At-least-once delivery is guaranteed even if the process crashes mid-request. |
| **Idempotency**        | Duplicate-request safety    | Callers supply an optional `idempotency_key`. `CreateUserHandler` checks Redis before executing — duplicate requests within 24 h return the cached response with zero side-effects.                                                                                                                                                                                                                 |
| **Circuit breaker**    | Fail-fast on flaky deps     | Custom CLOSED/OPEN/HALF_OPEN state machine wrapping OPA HTTP calls. After 5 failures the circuit opens — requests fail immediately instead of blocking on timeouts. Resets after 30 s.                                                                                                                                                                                                              |
| **DLQ + retry**        | Permanent failure isolation | Jobs that exhaust all BullMQ retry attempts are routed to a `dead-letter` queue. Visible in Bull Board. Admins can replay any DLQ job back to its source queue.                                                                                                                                                                                                                                     |
| **Feature flags**      | Runtime feature gating      | Flags stored in a Redis hash — `HSET feature-flags <name> 1` enables, `HDEL` disables. Zero deploy needed. Use `@FeatureFlag('name')` guard or `FeatureFlagsService.isEnabled()` programmatically.                                                                                                                                                                                                  |
| **Replay-safe events** | Idempotent side-effects     | Every domain event carries a UUID `eventId`. Before executing side-effects (ES index, BullMQ enqueue, vector upsert), the handler checks Redis with `SET NX` — duplicate events are silently skipped.                                                                                                                                                                                               |

### APIs & real-time

| Technology                 | Type                  | Use this when…                                                                                                                                                            |
| -------------------------- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **REST**                   | Health + Metrics only | `/api/health` (k8s probes), `/api/metrics` (Prometheus scrape). All business logic is gRPC only.                                                                          |
| **gRPC**                   | Binary RPC            | Internal service-to-service calls needing strong typing and 5–10× HTTP/1.1 throughput. Protocol Buffers enforce the contract at compile time.                             |
| **WebSockets (Socket.io)** | Persistent connection | Server needs to push to the browser without polling. Live notifications, dashboard counters, profile updates pushed to the user's own room. JWT-authenticated on connect. |
| **Envoy**                  | Proxy                 | Browsers cannot speak raw gRPC. Envoy transcodes gRPC-Web (HTTP/1.1) → gRPC (HTTP/2) so the React frontend can call backend gRPC services directly.                       |

### Notifications

| Channel         | Technology                               | Use this when…                                                                                                                                   |
| --------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Email**       | Nodemailer → MailHog (dev) / SMTP (prod) | Welcome emails, password resets, subscription alerts. MailHog traps all mail in dev — nothing is sent for real. View at `http://localhost:8025`. |
| **SMS**         | Twilio stub (swap in prod)               | OTP codes, critical alerts. Set `SMS_PROVIDER=twilio` and add credentials for production. Stub logs the message to the console in dev.           |
| **In-app push** | WebSocket (NotificationGateway)          | Real-time alerts delivered while the user has the browser open. Routed via `sendToUser(userId, event, data)` → user's room.                      |

### Observability

| Technology            | Type               | Use this when…                                                                                                                                                                                                                                                                                                               |
| --------------------- | ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **OpenTelemetry SDK** | Tracing            | Auto-instruments every HTTP request, MongoDB query, Redis call, gRPC call. Emits spans without touching business logic. One SDK — swap exporters freely.                                                                                                                                                                     |
| **OTel Collector**    | Pipeline           | Receives spans/metrics from the app, buffers, fans out to Jaeger and Prometheus. Decouples the app from observability backends.                                                                                                                                                                                              |
| **Jaeger**            | Trace UI           | Visualise the full lifecycle of any request — which DB was hit, how long each call took, where latency lives. Search by trace ID or service name.                                                                                                                                                                            |
| **Prometheus**        | Metrics scraper    | Pulls numeric time-series from NestJS (`/api/metrics`) and OTel Collector every 15 s. Source of truth for all dashboards and alerts.                                                                                                                                                                                         |
| **Grafana**           | Dashboards         | Queries Prometheus for graphs, Jaeger for trace search — all in one UI. Auto-provisioned with Prometheus + Jaeger datasources. Default: `admin / admin` at `http://localhost:3101`.                                                                                                                                          |
| **Pino**              | Structured logging | Fast JSON logs on every request. `CorrelationIdMiddleware` assigns a UUID (`x-request-id`) per request — propagated through logs so a single request can be traced across MongoDB, Redis, Pulsar, ClickHouse, and Vault in the same log drain. Pretty-prints in dev, ships raw JSON in prod for log aggregators (Loki, ELK). |

### Auth, safety, quality

| Technology                       | Role                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **JWT + Passport.js**            | Stateless auth with short-lived access tokens and long-lived refresh tokens. `POST /auth/login` returns `{ accessToken, refreshToken }`. `POST /auth/refresh` rotates the pair (old refresh token is deleted on use). `POST /auth/logout` blacklists the `jti` claim in Redis with a TTL matching the token's remaining lifetime — revocation takes effect immediately on the next request. Roles (`admin`, `editor`, `viewer`) and `tenantId` are embedded in the access token at sign time.                                                                                                                                                                                                                  |
| **OAuth2 / SSO**                 | `GET /api/auth/google` and `GET /api/auth/github` redirect to the provider consent screen. On callback, `OAuthService.findOrCreate()` looks up the user by provider identity, links to an existing email account if found, or creates a new account. Issues a standard app JWT so downstream code is provider-agnostic. `passport-oauth2` is used for GitHub (maintained, Feb 2024); the strategy manually fetches user profile and verified primary email via the GitHub REST API.                                                                                                                                                                                                                            |
| **Cursor pagination**            | `UserRepository.findPage(limit, tenantId, cursor?)` implements keyset pagination on `_id`. Returns `{ data, nextCursor, hasMore }` — pass `nextCursor` as the `cursor` for the next page. Stable under concurrent inserts/deletes and avoids full-collection `COUNT` queries; use this over offset pagination at scale. Offset pagination (`findAll`) remains for backwards-compatible gRPC responses.                                                                                                                                                                                                                                                                                                         |
| **Multi-tenancy**                | Every user document carries a `tenantId`. `UserRepository` appends `{ tenantId }` to every query — users from different tenants are completely invisible to each other. `TenantMiddleware` extracts `tenantId` from the JWT or `X-Tenant-ID` header on every HTTP request. Header override is blocked when a JWT is present, preventing tenant-escalation via header injection. Compound unique index on `(email, tenantId)` allows the same email across tenants. `GrpcTenantInterceptor` (request-scoped, registered as global `APP_INTERCEPTOR`) mirrors this behaviour for gRPC calls — it extracts `tenantId` from the gRPC authorization metadata and populates `TenantContext` before any handler runs. |
| **RBAC**                         | `@Roles('admin')` decorator + `RolesGuard` restrict HTTP routes by role. Three roles: `admin` (full access), `editor` (create + update, no delete), `viewer` (read only). New users get `editor` by default; delete requires `admin`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| **OPA**                          | Mutating gRPC methods (`Update`, `Replace`, `Delete`) ask OPA's REST API whether the caller's roles allow the requested action. Policy lives in `infra/opa/authz.rego` — edit Rego and restart OPA, no code deploy needed.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| **helmet**                       | Sets HTTP security headers on every response — X-Frame-Options, HSTS, Content-Security-Policy, X-Content-Type-Options, etc. One `app.use(helmet())` call in `main.ts`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| **ValidationPipe**               | Global NestJS pipe applied in `main.ts`. `whitelist: true` strips unknown fields, `forbidNonWhitelisted: true` throws 400 instead of silently ignoring them, `transform: true` auto-casts query params to their DTO types.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| **Joi config validation**        | `config/env.validation.ts` — Joi schema validates every env var at startup. `JWT_SECRET` is `required()` with `min(32)`. App refuses to start with a missing or weak config instead of failing silently later.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| **@nestjs/throttler**            | Rate-limits per IP. 100 req / 60 s globally. `POST /auth/login` tightened to 10 req / 60 s. OAuth callbacks limited to 20 req / 60 s — prevents brute-force and spam user creation. `gRPC AuthService/Login` is independently rate-limited to 10 attempts / 60 s per email via a Redis counter (`grpc:login:rl:{email}`) — throttler doesn't cover gRPC.                                                                                                                                                                                                                                                                                                                                                       |
| **Husky + lint-staged**          | Blocks commits that fail ESLint or Prettier. Keeps the tree clean without relying on CI catching it after the fact.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| **Frontend error normalisation** | `src/lib/error.ts` — `parseApiError(err)` converts any thrown value (GrpcError, fetch Error, unknown) into `{ code, message, isAuth, isNetwork }`. gRPC status codes are mapped to user-readable strings. All components catch errors through this helper for consistent error display.                                                                                                                                                                                                                                                                                                                                                                                                                        |
| **Jest**                         | Backend unit suite. Coverage enforced in CI: lines ≥ 70%, statements ≥ 70%, branches ≥ 60%, functions ≥ 60%.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| **React Testing Library**        | Frontend component tests (rendering, interactions, error handling). Run via Vitest in CI.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| **pnpm audit**                   | Scans all npm dependencies for known CVEs on every CI run. Fails on `high` severity findings.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| **Gitleaks**                     | Scans every commit for accidentally committed secrets (API keys, passwords, private keys, JWTs). Runs in CI before any build.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| **CodeQL**                       | GitHub's free SAST — static analysis of TypeScript source for injection flaws, prototype pollution, insecure patterns. Results in the Security tab.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| **SonarCloud**                   | Code quality gate: smells, duplication %, coverage trend, security hotspots. Posts a summary comment on every PR. Free for public repos.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| **Dependabot**                   | Opens PRs automatically when npm/Maven/GitHub Actions dependencies have new versions or CVEs. Grouped by ecosystem (NestJS, OTel, devtools). Major bumps excluded for manual review.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |

---

## Port map

| Service                      | Port  | URL / notes                                                                                              |
| ---------------------------- | ----- | -------------------------------------------------------------------------------------------------------- |
| Frontend (Vite)              | 5173  | http://localhost:5173                                                                                    |
| Backend HTTP                 | 3100  | http://localhost:3100/api                                                                                |
| Backend WebSocket            | 3100  | ws://localhost:3100/ws (namespace `/ws`, same port as HTTP)                                              |
| Backend gRPC (public tier)   | 50051 | —                                                                                                        |
| Backend gRPC (internal tier) | 50061 | `app.<domain>.internal.v1` — cluster-only in production (ClusterIP + NetworkPolicy)                      |
| Swagger UI                   | 3100  | http://localhost:3100/api/docs                                                                           |
| Prometheus metrics           | 3100  | http://localhost:3100/api/metrics                                                                        |
| MongoDB                      | 27018 | host port (container 27017; compose maps `27018:27017`)                                                  |
| PostgreSQL                   | 5432  | —                                                                                                        |
| Redis                        | 6379  | also used by BullMQ queues                                                                               |
| ClickHouse HTTP              | 8123  | —                                                                                                        |
| ClickHouse native            | 9000  | —                                                                                                        |
| Aerospike client             | 3000  | —                                                                                                        |
| Pulsar binary                | 6650  | —                                                                                                        |
| Pulsar HTTP admin            | 8080  | —                                                                                                        |
| Pulsar Manager               | 9527  | http://localhost:9527 — Pulsar web UI                                                                    |
| Flink Web UI                 | 8081  | http://localhost:8081 (`analytics` profile)                                                              |
| Envoy gRPC-Web               | 8090  | frontend → gRPC calls go here                                                                            |
| Envoy admin                  | 9901  | http://localhost:9901                                                                                    |
| Signing (Rust gRPC)          | 50052 | `rust` profile — `tropis.signing.v1`                                                                     |
| Jaeger UI                    | 16686 | http://localhost:16686                                                                                   |
| OTel Collector gRPC          | 4317  | —                                                                                                        |
| OTel Collector HTTP          | 4318  | NestJS sends traces here                                                                                 |
| OTel Collector metrics       | 8888  | host-exposed self-metrics; Prometheus scrapes `:8888` (self) + `:8889` (exported app metrics) in-network |
| Elasticsearch                | 9200  | —                                                                                                        |
| MinIO S3 API                 | 9900  | —                                                                                                        |
| MinIO Console                | 9902  | http://localhost:9902                                                                                    |
| MailHog SMTP                 | 1025  | NestJS / Nodemailer sends here                                                                           |
| MailHog Web UI               | 8025  | http://localhost:8025 — view all dev emails                                                              |
| RedisInsight                 | 5540  | http://localhost:5540 — Redis browser UI                                                                 |
| Bull Board                   | 3100  | http://localhost:3100/api/queues — BullMQ job dashboard                                                  |
| Vault UI                     | 8200  | http://localhost:8200 — Secret management (token: dev-root-token)                                        |
| Mongo Express                | 8085  | http://localhost:8085 — MongoDB browser                                                                  |
| pgAdmin                      | 5050  | http://localhost:5050 — PostgreSQL admin (admin@local.dev / admin)                                       |
| Kibana                       | 5601  | http://localhost:5601 — Elasticsearch UI                                                                 |
| CH-UI                        | 8124  | http://localhost:8124 — ClickHouse query UI (URL: http://localhost:8123, user: default)                  |
| Prometheus                   | 9090  | http://localhost:9090                                                                                    |
| Alertmanager                 | 9093  | http://localhost:9093 — alert routing (Slack/webhook, `observability` profile)                           |
| Grafana                      | 3101  | http://localhost:3101 — admin / admin                                                                    |
| OPA                          | 8181  | http://localhost:8181 — policy query API                                                                 |
| Temporal gRPC                | 7233  | — workers + NestJS client connect here                                                                   |
| Temporal Web UI              | 8233  | http://localhost:8233 — workflow history, status, signals                                                |
| Dozzle                       | 9999  | http://localhost:9999 — live container log viewer (`tools` profile)                                      |
| Metabase                     | 3200  | http://localhost:3200 — BI dashboards over ClickHouse (`tools` profile; host 3000 taken by Aerospike)    |

> **BullMQ and WebSockets need no extra containers.** BullMQ uses the existing Redis on port 6379. WebSockets run on the existing NestJS HTTP server (port 3100, namespace `/ws`).
> **Temporal** runs three containers: `temporal` (server), `temporal-ui` (web UI), and `postgresql-temporal` (its own isolated Postgres DB).

---

## Getting started

### 1. Prerequisites

```bash
node >= 22
pnpm >= 10
docker + docker compose
```

### 2. Start infrastructure

```bash
make up        # core services only (everything /api/health probes + mailhog)
make up-all    # full stack — core + analytics + observability + tools profiles (~8GB+ Docker memory)
```

`make up` starts every datastore, broker, and infra dependency the backend needs. Flink lives behind the `analytics` profile, the tracing/metrics pipeline behind `observability`, and the datastore web UIs behind `tools` — see the profile table above and `infra/docker/docker-compose.yml` for the current container list.

Wait ~20 seconds for Pulsar and Elasticsearch to be ready (they are the slowest to start).

### 3. (Optional) Start Vault and load secrets

```bash
docker compose -f infra/docker/docker-compose.yml up -d vault vault-init

# Wait ~5s then check for the app token
docker logs tropis_vault_init

# Copy VAULT_ADDR and VAULT_TOKEN into apps/backend/.env
# Leave blank to skip Vault and use .env values directly
```

### 4. ClickHouse tables

The four init scripts (`init-analytics.sql`, `init-user-events.sql`, `init-tracking.sql`, `init-audit.sql`) are mounted into the container and run automatically on the **first** start with an empty volume. To (re-)apply manually:

```bash
docker exec -i tropis_clickhouse clickhouse-client < infra/clickhouse/init-user-events.sql
docker exec -i tropis_clickhouse clickhouse-client < infra/clickhouse/init-analytics.sql
docker exec -i tropis_clickhouse clickhouse-client < infra/clickhouse/init-tracking.sql
docker exec -i tropis_clickhouse clickhouse-client < infra/clickhouse/init-audit.sql
```

### 5. Install dependencies (run once from repo root)

```bash
pnpm install
```

### 6. Run in development

```bash
pnpm dev          # backend + frontend + temporal-worker concurrently (recommended)
pnpm backend      # NestJS only          → http://localhost:3100/api
pnpm frontend     # React only           → http://localhost:5173
pnpm worker       # Temporal worker only → polls queue "main" on localhost:7233
```

---

## Common commands

### Dev servers

```bash
pnpm dev                        # start backend + frontend + temporal worker together
pnpm backend                    # start backend only
pnpm frontend                   # start frontend only
pnpm worker                     # start temporal worker only
pnpm build                      # build all workspaces
pnpm test                       # run all Jest tests
pnpm lint                       # lint all workspaces
```

### Kill stuck ports

```bash
lsof -i :3100                                              # who owns a port
kill -9 $(lsof -ti :3100 -ti :50051 -ti :5173) 2>/dev/null # free the dev ports
```

> **Tip:** Always use `Ctrl+C` to stop, not `Ctrl+Z`. `Ctrl+Z` suspends the process but keeps the port held in the background.

### Docker — start / stop

```bash
docker compose -f infra/docker/docker-compose.yml up -d
docker compose -f infra/docker/docker-compose.yml down
docker compose -f infra/docker/docker-compose.yml down -v   # wipe volumes
docker compose -f infra/docker/docker-compose.yml restart <service>
```

### Docker — status and logs

Containers are named `tropis_<service>` — same pattern for every service (see `docker ps`):

```bash
docker ps
docker logs -f tropis_pulsar          # follow
docker logs --tail 50 tropis_pulsar   # last 50 lines
```

### Docker — individual services

```bash
# Start only what you need
docker compose -f infra/docker/docker-compose.yml up -d mongodb redis clickhouse postgres elasticsearch

# Stop one service
docker compose -f infra/docker/docker-compose.yml stop pulsar

# Remove + recreate fresh
docker compose -f infra/docker/docker-compose.yml rm -f pulsar
docker compose -f infra/docker/docker-compose.yml up -d pulsar
```

### Pulsar Manager (web UI)

```bash
# Open http://localhost:9527
# First time only — create the admin account:
CSRF_TOKEN=$(curl -s http://localhost:7750/pulsar-manager/csrf-token)
curl -X PUT http://localhost:7750/pulsar-manager/users/superuser \
  -H "X-XSRF-TOKEN: $CSRF_TOKEN" \
  -H "Cookie: XSRF-TOKEN=$CSRF_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"admin","password":"admin123","description":"admin","email":"admin@local.dev"}'

# Then log in at http://localhost:9527 with admin / admin123
# Add environment: Service URL = http://pulsar:8080
```

### Redis

The pattern is always `docker exec -it tropis_redis redis-cli <command>`:

```bash
docker exec -it tropis_redis redis-cli                               # interactive shell
docker exec -it tropis_redis redis-cli GET "user:<userId>"           # inspect a cached user
docker exec -it tropis_redis redis-cli HGETALL feature-flags         # list feature flags
```

Everything else (BullMQ `bull:*` keys, `idem:*` idempotency keys, flag
toggles) follows the same pattern — key prefixes live in each module's
`constants/`; RedisInsight (below) browses them all visually.

### RedisInsight (Redis Web UI)

```bash
# Open http://localhost:5540
# First visit: click "Add Redis Database"
#   Host: redis   Port: 6379   (use the Docker service name, not localhost)
#
# Features: key browser, memory profiler, pub/sub monitor, slow log, CLI
```

### PostgreSQL

```bash
docker exec -it tropis_postgres psql -U tropis -d tropis

# pgvector: run a cosine similarity search
SELECT id, content, embedding <=> '[0.1, 0.2, ...]'::vector AS distance
FROM documents
ORDER BY distance
LIMIT 5;
```

### Elasticsearch

```bash
# Health check
curl http://localhost:9200/_cluster/health?pretty

# List indices
curl http://localhost:9200/_cat/indices?v

# Search users index
curl -X GET "http://localhost:9200/users/_search?pretty" \
  -H 'Content-Type: application/json' \
  -d '{"query": {"match_all": {}}}'
```

### MinIO

```bash
# Console UI → http://localhost:9902  (minioadmin / minioadmin123)

# Install mc (MinIO client)
brew install minio/stable/mc
mc alias set local http://localhost:9900 minioadmin minioadmin123

# List buckets
mc ls local

# Upload a file
mc cp ./myfile.pdf local/app-uploads/

# List objects
mc ls local/app-uploads
```

### MailHog

```bash
# All emails sent in dev are caught here — nothing is sent for real
# Open http://localhost:8025 to browse received messages
```

### ClickHouse

```bash
docker exec -it tropis_clickhouse clickhouse-client

docker exec -i tropis_clickhouse clickhouse-client < infra/clickhouse/init-user-events.sql
docker exec -i tropis_clickhouse clickhouse-client < infra/clickhouse/init-analytics.sql

docker exec -it tropis_clickhouse clickhouse-client \
  --query "SELECT * FROM logs.analytics_events LIMIT 10"
```

### Prometheus & Grafana

```bash
# Prometheus UI → http://localhost:9090
# Try: query "http_requests_total" to see request counts

# Grafana → http://localhost:3101  (admin / admin)
# Datasources are auto-provisioned: Prometheus + Jaeger
```

### gRPC (grpcurl)

```bash
# Install: brew install grpcurl
# The pattern is always the same — point at the proto, name the fully-qualified RPC:

# 1. Health check
grpcurl -plaintext -proto proto/health/v1/health.proto \
  localhost:50051 tropis.health.v1.HealthService/Check

# 2. Login → take access_token from the response
grpcurl -plaintext -proto proto/auth/v1/auth.proto \
  -d '{"email":"admin@example.com","password":"Password123!"}' \
  localhost:50051 tropis.auth.v1.AuthService/Login

# 3. Authenticated call — Bearer token via gRPC metadata
grpcurl -plaintext -proto proto/user/v1/user.proto \
  -H "authorization: Bearer <access_token>" \
  localhost:50051 tropis.user.v1.UserService/GetMe
```

Every other RPC follows the same pattern — service names, methods, and message
shapes are in `proto/<domain>/v1/<domain>.proto` (the single source of truth).

### WebSockets

Namespace `/ws`, same port as HTTP (3100). Pass the JWT in the handshake auth object.

```js
import { io } from 'socket.io-client';

const socket = io('http://localhost:3100/ws', {
  auth: { token: '<jwt>' }, // from POST /api/auth/login
});

socket.on('connect', () => console.log('connected', socket.id));

// Events pushed by the server
socket.on('user.created', (data) => console.log('new user broadcast', data));
socket.on('user.updated', (data) => console.log('your profile changed', data));
socket.on('notification', (data) => console.log('notification', data));

// Health check round-trip
socket.emit('ping');
socket.on('pong', ({ ts }) => console.log('round-trip ms:', Date.now() - ts));
```

### OPA (policy engine)

```bash
# OPA REST API → http://localhost:8181

# Test if an editor can update a user
curl -s -X POST http://localhost:8181/v1/data/authz/allow \
  -H "Content-Type: application/json" \
  -d '{"input":{"roles":["editor"],"resource":"user","action":"update"}}' | jq

# Test if a viewer can delete a user (should be false)
curl -s -X POST http://localhost:8181/v1/data/authz/allow \
  -H "Content-Type: application/json" \
  -d '{"input":{"roles":["viewer"],"resource":"user","action":"delete"}}' | jq

# See all actions allowed for a role/resource combo
curl -s -X POST http://localhost:8181/v1/data/authz/allowed_actions \
  -H "Content-Type: application/json" \
  -d '{"input":{"roles":["editor"],"resource":"user"}}' | jq

# Policy file → infra/opa/authz.rego
# Edit the Rego file and restart the OPA container to apply changes — no code redeploy needed
docker compose -f infra/docker/docker-compose.yml restart opa
```

### Temporal (workflow orchestration)

```bash
# Web UI → http://localhost:8233
# Browse running/completed/failed workflows, view event history, send signals, terminate runs

# Trigger the sample notification workflow from any NestJS service:
#   inject TemporalService and call:
#   await this.temporalService.startWorkflow('notificationWorkflow', [input])

# Check worker logs
docker logs tropis_temporal          # Temporal server logs
# pnpm worker                    # worker process stdout — shows polled tasks

# Temporal server connects to its own Postgres (not the app DB)
docker exec -it tropis_temporal_postgres psql -U temporal -d temporal
```

### BullMQ (job queue)

Jobs are enqueued automatically by the app (welcome notification on user create, etc.). Bull Board is mounted at `http://localhost:3100/api/queues` — no extra container needed. It shows waiting, active, completed, and failed jobs for every queue with per-job data and retry controls. For raw inspection, queue state lives in Redis under `bull:<queue>:*` (see the Redis section above).

### Processes

```bash
ps aux | grep node

lsof -i :3100
lsof -i :50051
lsof -i :5173

kill -9 <pid>
```

---

## Frontend architecture

The React app is a single-page application that talks to the backend via gRPC-Web (through Envoy) using `@tropis/sdk`. REST is used only for the approved gap-fillers (login/OAuth, tracking beacon ingest).

Route-level pages live in `src/pages/` (one thin page per nav tab — analytics dashboard, users, stack links, state demo, behavior insights); each page composes feature folders from `src/features/`. Current set: look at the directories — layout rules in [docs/project-structure.md](docs/project-structure.md).

### State management — 3 patterns

The `src/state/` folder demonstrates three distinct approaches to the same problem:

```
state/
├── local/       useState + useEffect hooks — fetch on mount, no sharing
├── zustand/     Global client stores (auth, toasts) — shared, manual invalidation
└── tanstack/    TanStack Query hooks — server cache (staleTime 30s, gcTime 5min, retry 2)
```

#### When to use each

| Pattern                      | Best for                                                    | Key limitation                                                                     |
| ---------------------------- | ----------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| **Local state** (`useState`) | Form state, UI toggles, component-local data                | Re-fetches every mount; state is lost on unmount; no sharing without prop-drilling |
| **Zustand**                  | Auth session, toasts, UI globals, client-cached server data | Manual cache invalidation; no background refetch                                   |
| **TanStack Query**           | Any server data that multiple components read               | Overkill for purely local UI state                                                 |

#### Key differences to observe on the ⚡ State tab

- Open the page with **All 3** selected — all three panels fetch independently.
- The **Local** panel fires a new HTTP call every time the component mounts.
- The **Zustand** panel skips the network if data was fetched in the last 30 seconds.
- The **TanStack** panel auto-refetches in the background when you switch back to the browser tab (`refetchOnWindowFocus: true`). The "Cache age" badge counts seconds since the last successful fetch.

### gRPC-Web client (`@tropis/sdk`)

All backend gRPC communication goes through the SDK (`packages/sdk`), which the frontend consumes via `@tropis/sdk` (wired up in `src/lib/api.ts`). Proto types are generated with buf (`make proto` → `packages/sdk/src/gen/`); the gRPC-Web transport lives in `packages/sdk/src/client/`.

```
Browser → Envoy :8090 (HTTP/1.1 gRPC-Web)
             ↓
        Envoy transcodes
             ↓
        NestJS :50051 (HTTP/2 gRPC)
```

The SDK also ships REST helpers (`src/rest/`), a Socket.io realtime client (`src/realtime/`), and the tracking SDK (`src/tracking/` — batches events and flushes via `navigator.sendBeacon`).

---

## Backend architecture

Every feature module follows the same layered anatomy — controllers/processors (thin) → services (all business logic) → repositories (the only DB access) → schemas, with transformers as the only door out and constants for every string. The authoritative anatomy, layer rules, and placement tiers live in [docs/project-structure.md](docs/project-structure.md) (CI-enforced by dependency-cruiser).

### Example: request → response flow (User create)

Illustrative walkthrough of the flagship write path — the PATTERN (transaction
→ outbox → async fan-out → idempotency) is the stable contract here; exact
class/key names live in `modules/user/` and may evolve with the code.

```
gRPC UserService/Create { name, email, password, idempotency_key? }
  │
  ▼ UserGrpcController.create()
  │
  ▼ UserService.create(dto)
  │
  ▼ CommandBus.execute(CreateUserCommand)
  │
  ▼ CreateUserHandler.execute()
  │   ① Redis check: idem:create-user:<key>  ── HIT → return cached response immediately
  │
  │   ② MongoDB transaction (session.withTransaction):
  │       UserRepository.createWithSession()     → users collection
  │       UserEventStore.appendWithSession()     → user_event_store collection (version 1)
  │       OutboxService.write()                  → outbox collection (status=PENDING)
  │       (all three commit atomically)
  │
  │   ③ EventEmitter.emit(UserCreatedEvent)
  │       └─ UserEventHandlers.onUserCreated()
  │            Redis NX check (dedup by eventId)
  │            ├─ searchService.index()           → Elasticsearch
  │            ├─ vectorService.upsertVector()    → pgvector
  │            ├─ queueService.enqueueNotification() → BullMQ (welcome email, 3 retries)
  │            └─ notificationGateway.broadcast() → WebSocket ('user.created' to all)
  │
  │   ④ Redis set: idem:create-user:<key> = response (24 h TTL)
  │
  ▼ logToClickHouse()   → ClickHouse audit log (email encrypted via Vault Transit)
  │
  ▼ gRPC response
        │
        └─ OutboxRelay (every 5 s, separate scheduler)
             fetch PENDING outbox rows
             PulsarClient.send() → mark DISPATCHED
             on failure          → mark FAILED → requeueFailed after < 5 attempts
```

### Bootstrap order (`main.ts`)

```
NestFactory.create(AppModule)
  │
  ├─ app.use(helmet())                    HTTP security headers
  ├─ app.enableCors({ origin, credentials })   allow frontend origin
  ├─ app.useGlobalPipes(ValidationPipe)   strip + validate all input
  ├─ app.setGlobalPrefix('api')           all routes under /api
  ├─ SwaggerModule.setup('api/docs')      only in non-production
  ├─ app.connectMicroservice(GRPC) ×2     public gRPC :50051, internal tier :50061
  ├─ app.enableShutdownHooks()            SIGTERM → graceful drain
  └─ app.listen(PORT)                     HTTP on port 3100
```

ConfigModule validates every env var via Joi schema before any of the above runs. If `JWT_SECRET` is missing or shorter than 32 characters, the process exits with a clear error message — not a runtime exception buried in a request log.

### CQRS + Event Sourcing (User module)

The User module uses `@nestjs/cqrs` to separate writes from reads and appends every state change to an immutable event log.

```
Write path (command)
  UserService.create(dto)
    └─ CommandBus.execute(CreateUserCommand)
         └─ CreateUserHandler
              ├─ UserRepository.create()         → MongoDB (current state)
              ├─ UserEventStore.append()         → MongoDB user_event_store (history)
              └─ EventEmitter.emit(UserCreated)  → side-effects (ES, pgvector, BullMQ, WS)

Read path (query)
  UserService.findById(id)
    └─ QueryBus.execute(GetUserQuery)
         └─ GetUserHandler
              ├─ Redis.get('user:{id}')  ── HIT  → return (sub-ms)
              └─ MISS
                   UserRepository.findById()  → MongoDB
                   Redis.set(...)             → cache 5 min
```

**Event store** — `user_event_store` collection in MongoDB:

```
{ aggregateId, type: 'UserCreated', payload: {...}, version: 1, occurredAt }
{ aggregateId, type: 'UserUpdated', payload: {...}, version: 2, occurredAt }
{ aggregateId, type: 'UserDeleted', payload: {...}, version: 3, occurredAt }
```

Replay any user's full history: `UserEventStoreService.replay(userId)` applies each event in order to reconstruct state. Useful for audit, debugging, or rebuilding a corrupted read model.

### Redis caching pattern (cache-aside)

```
GET /api/users/:id
  │
  ├─ redis.get('user:{id}')  ── HIT  → return immediately (sub-ms)
  │
  └─ MISS
       UserRepository.findById()           → MongoDB query
       redis.set('user:{id}', ..., EX 300) → cache 5 min
       return response

Cache busted from two places:
  UserService.update() / .delete()   — synchronous, immediate
  UserProcessor (Pulsar consumer)    — belt-and-suspenders
```

---

## OAuth2 / SSO

Standard password login works for direct users. OAuth2 adds sign-in with Google and GitHub so users never have to create a password.

### Flow

```
Browser → GET /api/auth/google
            └─ Passport redirects to Google consent screen

Google → GET /api/auth/google/callback?code=...
            └─ GoogleStrategy.validate()  →  OAuthUserProfile { provider, providerId, email, name }
            └─ OAuthService.findOrCreate()
                 1. Look up by (provider, providerId, tenantId)  ── found → issue JWT
                 2. Look up by email                             ── found → link provider, issue JWT
                 3. Neither found                                ── create new user, issue JWT
            └─ Redirect to frontend: /auth/callback?token=<jwt>

Frontend stores the JWT (same format as password login) — all downstream code is provider-agnostic
```

### User schema additions

```typescript
provider?:   string  // 'google' | 'github'
providerId?: string  // provider-side ID (stable across renames)
```

OAuth users have `passwordHash: ''` — they cannot log in with a password unless one is later set.

### Setup

**Google:**

1. Go to [Google Cloud Console](https://console.cloud.google.com) → APIs & Services → Credentials
2. Create OAuth 2.0 Client ID → Web application
3. Add authorised redirect URI: `http://localhost:3100/api/auth/google/callback`
4. Copy Client ID and Secret into `.env`

**GitHub:**

1. Go to GitHub → Settings → Developer settings → OAuth Apps → New OAuth App
2. Set callback URL: `http://localhost:3100/api/auth/github/callback`
3. Copy Client ID and Secret into `.env`

```env
GOOGLE_CLIENT_ID=your-google-client-id
GOOGLE_CLIENT_SECRET=your-google-client-secret
GOOGLE_CALLBACK_URL=http://localhost:3100/api/auth/google/callback

GITHUB_CLIENT_ID=your-github-client-id
GITHUB_CLIENT_SECRET=your-github-client-secret
GITHUB_CALLBACK_URL=http://localhost:3100/api/auth/github/callback
```

Leave blank to disable the provider — the routes will return a 500 if credentials are missing.

### Endpoints

```
GET /api/auth/google          → redirect to Google consent screen
GET /api/auth/google/callback → OAuth callback (handled by Passport)
GET /api/auth/github          → redirect to GitHub consent screen
GET /api/auth/github/callback → OAuth callback (handled by Passport)
```

---

## Multi-tenancy

Every user belongs to exactly one **tenant** — an isolated namespace. Users from different tenants cannot see each other's data even if they share the same MongoDB database.

### How it works

**Schema:** `tenantId` field on every `User` document. Defaults to `'default'` for single-tenant / self-hosted deployments.

**Indexes:**

```
{ email: 1, tenantId: 1 }  unique  → same email allowed in different tenants
{ provider: 1, providerId: 1, tenantId: 1 }  sparse  → fast OAuth lookup per tenant
```

**Repository isolation:** `UserRepository` wraps every query filter with `{ tenantId, deletedAt: null }` — every method takes `tenantId = DEFAULT_TENANT` so single-tenant setups just work. No query can accidentally cross tenant boundaries.

**JWT:** `tenantId` is embedded in every token at sign time. No extra lookup on each request.

**TenantMiddleware** (applied to all HTTP routes):

```
Priority 1 — JWT claim: jwt.tenantId  (locks the tenant — X-Tenant-ID header is ignored)
Priority 2 — X-Tenant-ID header       (only honoured when no JWT is present)
Priority 3 — falls back to 'default'
```

> **Security note:** if a valid JWT is present, the `X-Tenant-ID` header is silently ignored. This prevents authenticated users from switching tenants by sending an arbitrary header (tenant-hopping attack).

**TenantContext** is request-scoped — inject it anywhere in the request lifecycle without threading `tenantId` through every method call.

### Adding a new tenant

There's no admin API yet — tenants are bootstrapped by inserting a user with the desired `tenantId`:

```bash
# via grpcurl — set X-Tenant-ID header (gRPC metadata) or pass tenantId in a seed script
grpcurl -plaintext -proto proto/user/v1/user.proto \
  -d '{"name":"Admin","email":"admin@acme.com","password":"Password123!"}' \
  localhost:50051 tropis.user.v1.UserService/Create
# Then update the document directly: db.users.updateOne({email:'admin@acme.com'}, {$set:{tenantId:'acme'}})
```

In production you'd add a `POST /api/tenants` endpoint that creates the first admin user with the new `tenantId`.

---

## Reliability patterns

Six patterns that solve real production failure modes. Each is independently testable and can be disabled without touching business logic.

### Outbox pattern (atomic event delivery)

**Problem it solves:** without the outbox, `CreateUserHandler` wrote to MongoDB then published to Pulsar. If the process crashed between the two, the user existed in the DB but no domain event fired — downstream systems (ES, BullMQ, vector store) were never notified.

**How it works:**

```
CreateUserHandler.execute()
  └─ session.withTransaction()
       ├─ UserRepository.createWithSession()    → writes user document
       ├─ UserEventStore.appendWithSession()    → writes to user_event_store
       └─ OutboxService.write()                 → writes PENDING row to outbox collection
                         ↓ (all three commit atomically or all roll back)

OutboxRelay (every 5 s)
  └─ acquire Redis distributed lock (NX, 8 s TTL) — skips if another instance holds it
       └─ fetch PENDING rows (batch 50)
            └─ PulsarClient.send()    →  mark DISPATCHED
            └─ on failure             →  mark FAILED
  └─ release lock (Lua atomic check-and-delete)

OutboxRelay (every 60 s)
  └─ requeueFailed()    → reset FAILED rows with < 5 attempts back to PENDING
```

The Pulsar publish is decoupled from the business transaction. If Pulsar is down, the outbox accumulates PENDING rows and the relay retries independently. The Redis distributed lock ensures only one instance relays at a time in a horizontally-scaled deployment — preventing double-publish.

### Idempotency (duplicate-request protection)

**Problem it solves:** network retries and at-least-once delivery can cause the same create request to arrive twice. Without idempotency, two identical create calls would either duplicate the user or throw a 400.

**How it works:**

1. Caller supplies an optional `idempotency_key` in the gRPC request (or `idempotencyKey` in the DTO).
2. Before doing any work, `CreateUserHandler` checks Redis for `idem:create-user:<key>`.
3. If found → return the cached `IUserResponse` immediately (no DB writes, no events).
4. If not found → execute normally, then store the response with a 24 h TTL.

**Result:** identical requests within 24 h are idempotent — the first response is returned every time, with zero side effects on repeat calls.

### Circuit breaker (fail-fast on flaky dependencies)

**Problem it solves:** if OPA is slow or down, every gRPC call blocks waiting for a timeout. Under load this cascades — thread pool exhausts, the whole service stalls.

**How it works** (`CircuitBreaker` in `common/circuit-breaker/circuit-breaker.ts`):

```
State machine:
  CLOSED   → calls pass through normally; consecutive failures counted
  OPEN     → calls rejected immediately (CircuitBreakerOpenError); waits resetTimeoutMs (30 s)
  HALF_OPEN → one probe allowed; success → CLOSED, failure → OPEN again

OpaService wraps all fetch() calls in breaker.fire(() => ...)
  → after 5 consecutive OPA failures the circuit opens
  → OPA calls fail-fast for 30 s (returns false = deny by default)
  → after 30 s, one probe is tried; if OPA recovered, circuit closes
```

Zero external dependencies — the state machine is ~70 lines of pure TypeScript.

### DLQ + retry (dead-letter queue)

**Problem it solves:** BullMQ retries a failed job up to 3 times. After the third failure the job is marked `failed` and sits in Redis indefinitely. Without a DLQ, these jobs are invisible and never replayed.

**How it works:**

```
NotificationProcessor
  └─ job fails
       └─ @OnWorkerEvent('failed')
            ├─ if attempts remaining → BullMQ auto-retries (exponential backoff)
            └─ if attempts exhausted → enqueue to dead-letter queue
                   { ...originalData, __sourceQueue, __failReason }

DlqProcessor
  └─ logs permanently-failed jobs (visible in Bull Board /api/queues)
  └─ replayJob(dlqJob)  → re-enqueue on source queue + remove from DLQ
```

Bull Board at `http://localhost:3100/api/queues` shows all three queues: `notification`, `file-processing`, `dead-letter`.

### Feature flags (Redis-backed)

**Problem it solves:** deploying code is not the same as releasing a feature. Without flags, you need a deploy to enable or disable any behaviour.

**How it works:**

Flags live in a Redis hash `feature-flags`:

- value `"1"` = enabled, missing or anything else = disabled
- No TTL — flags persist until explicitly toggled

```bash
# Enable a flag
redis-cli HSET feature-flags new-checkout 1

# Disable a flag
redis-cli HDEL feature-flags new-checkout

# Inspect all flags
redis-cli HGETALL feature-flags
```

Use in a gRPC handler or controller:

```typescript
@UseGuards(FeatureFlagGuard)
@FeatureFlag('new-checkout')
async checkout() { ... }

// Or programmatically:
const enabled = await this.featureFlags.isEnabled('new-checkout');
if (enabled) { ... }
```

`FeatureFlagsModule` is `@Global()` — inject `FeatureFlagsService` anywhere.

### Replay-safe event handlers (idempotent side-effects)

**Problem it solves:** in-process events (`EventEmitter2`) fire once per request normally. But during event-store replay or crash-restart, the same event can fire again — causing duplicate Elasticsearch indexes, duplicate welcome emails, duplicate vector upserts.

**How it works:**

Each domain event now carries a `eventId = randomUUID()`. Before executing any side-effect, the handler does a Redis atomic SET NX:

```
Redis SET event:user.created:<eventId>  "1"  EX 86400  NX
  → result null   = key already existed → duplicate → skip
  → result "OK"   = first time          → execute side-effects
```

`NX` (set if not exists) is atomic — no race conditions even with concurrent workers. The 24 h TTL ensures the deduplication key doesn't grow forever.

---

## Production-grade patterns

### Domain events (EventEmitter2)

`UserService` emits typed domain events instead of calling side-effects inline.  
The `@nestjs/event-emitter` bus decouples the core business logic from infrastructure concerns.

```
UserService.create()
  └─ emits UserCreatedEvent
        ├─ UserEventHandlers.onUserCreated()
        │    ├─ searchService.index()         (Elasticsearch)
        │    ├─ vectorService.upsertVector()  (pgvector)
        │    ├─ queueService.enqueue()        (BullMQ welcome email)
        │    └─ notificationGateway.broadcast() (WebSocket)
        └─ logToClickHouse()                  (audit log — email encrypted via Vault Transit)
```

Benefits: `UserService` is testable without mocking 6 dependencies; each handler is independently deployable to a worker process.

### Structured error responses

All HTTP errors return a consistent JSON shape via `GlobalExceptionFilter`:

```json
{
  "success": false,
  "code": "NOT_FOUND",
  "message": "User not found",
  "traceId": "a3f1c2d4-...",
  "path": "/api/users/missing-id",
  "timestamp": "2026-01-01T00:00:00.000Z"
}
```

`code` is a stable machine-readable string (e.g. `BAD_REQUEST`, `UNAUTHORIZED`, `RATE_LIMITED`). Frontend clients switch on `code`, not on HTTP status or message text.  
`traceId` is propagated from the `x-trace-id` request header (or generated) and appears in every log line so you can correlate a user-reported error with the server log.

### PostgreSQL migrations (node-pg-migrate)

Schema changes are versioned in `apps/backend/migrations/`. The initial migration creates:

- `user_vectors` — stores 384-dimension embeddings with an IVFFlat cosine similarity index
- `documents` — stores file upload metadata (bucket, object key, size)

```bash
# Run all pending migrations
DATABASE_URL=postgres://tropis:tropis_dev_password@localhost:5432/tropis pnpm --filter @tropis/backend migrate:up

# Roll back last migration
DATABASE_URL=... pnpm --filter @tropis/backend migrate:down

# Create a new migration file
pnpm --filter @tropis/backend migrate:create -- my-change-name
```

---

## Infrastructure modules

Every external system gets exactly one `@Global()` NestJS module under `apps/backend/src/infrastructure/` that owns its client — business code injects the module's service/token and never imports drivers directly. The full module-per-system list and rules are in [docs/project-structure.md](docs/project-structure.md); config env vars are validated per module in `config/env.validation.ts`.

Two behaviors to rely on:

- **Graceful degradation** — modules WARN and continue when their backing service is down; affected endpoints return 503 or empty results. The verified per-dependency behavior is the "Degradation behavior" table in [docs/tech-decisions.md](docs/tech-decisions.md).
- **Queue policy example** (`QueueModule`): the `notification` queue retries ×3 with exponential backoff (2 s base); jobs that exhaust retries land on the `dead-letter` queue, inspectable/replayable via Bull Board. Other queues follow the same shape with their own retry settings — see `infrastructure/queue/`.

---

## Secret management — HashiCorp Vault

All application secrets live in Vault instead of committed config files. This mirrors how production deployments work on AWS, GCP, and Azure — those platforms use the same KV API under the hood (or Vault directly).

### Backend only — why the frontend never touches Vault

Vault is a **backend-only** integration. This is by design, not a limitation.

```
                        NEVER
Browser (React) ──────────────────▶  Vault
                                      ✗

Browser (React) ──▶ NestJS API ──▶  Vault  ✓
                   (holds the token,       (secrets stay
                    talks to Vault,         server-side)
                    returns only safe data)
```

The frontend only has three config values — `VITE_API_BASE_URL`, `VITE_GRPC_WEB_URL`, and `VITE_WS_URL` — which are **public URLs baked into the build bundle**, not secrets. Any operation that needs a credential (DB query, MinIO upload, Elasticsearch search, JWT signing) goes through the NestJS backend, which holds the real credentials fetched from Vault at startup.

**Rule:** if a secret would appear in the browser's network tab, it isn't a secret anymore. All secrets stay on the server.

### Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│  Backend (NestJS)                                                 │
│                                                                   │
│  main.ts                                                          │
│    └─ VaultModule.onModuleInit()                                  │
│         └─ fetch secret/tropis  ──────────────▶  Vault :8200   │
│         └─ merge into process.env ◀── all secrets ──             │
│                                                                   │
│  ConfigModule reads process.env (now contains Vault values)       │
│  RedisModule, PostgresModule, JwtModule... all read from config   │
└──────────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────────┐
│  Frontend (React)                                                 │
│                                                                   │
│  VITE_API_BASE_URL=http://localhost:3100       ← public URL only  │
│  VITE_GRPC_WEB_URL=http://localhost:8090       ← public URL only  │
│  VITE_WS_URL=http://localhost:3100             ← public URL only  │
│                                                                   │
│  No DB passwords. No JWT secrets. No API keys.                    │
│  All sensitive operations go through NestJS API calls.            │
└──────────────────────────────────────────────────────────────────┘
```

### How it works

1. `docker-compose up -d vault vault-init` starts Vault in dev mode and runs the init script
2. `vault-init` writes all secrets to `secret/tropis` and creates a scoped read-only app token
3. Copy the printed `VAULT_TOKEN` into `apps/backend/.env`
4. Set `VAULT_ADDR=http://localhost:8200`
5. On NestJS startup `VaultModule` fetches all secrets and injects them into `process.env` before any other module reads config

> **Opt-in, not required.** Leave `VAULT_ADDR` blank and the app falls back to plain `.env` values. Both modes work.

### Setup (run once)

```bash
# Start Vault + seed secrets
docker compose -f infra/docker/docker-compose.yml up -d vault vault-init

# Wait ~5s, then check the vault-init logs for the app token
docker logs tropis_vault_init

# Output includes:
#   VAULT_ADDR=http://localhost:8200
#   VAULT_TOKEN=hvs.xxxxxxxxxxxx   ← copy this
#
# Paste into apps/backend/.env:
#   VAULT_ADDR=http://localhost:8200
#   VAULT_TOKEN=hvs.xxxxxxxxxxxx
```

### Vault Web UI

Open http://localhost:8200 → sign in with token `dev-root-token`

- **Secrets** → `secret/tropis` — the flat map the app reads; grouped-by-concern subpaths (`secret/tropis/<group>`) mirror it for browsing. The seeded set is defined in `infra/vault/init.sh`.
- **Policies** → `tropis-app` — read-only policy attached to the app token
- **Access** → Tokens — inspect the app token TTL and capabilities

### Production pattern

In production you would replace the static `VAULT_TOKEN` with a dynamic auth method:

| Environment    | Auth method                                                  |
| -------------- | ------------------------------------------------------------ |
| Kubernetes     | `vault auth enable kubernetes` → pod's service account token |
| AWS EC2/ECS    | `vault auth enable aws` → IAM role                           |
| GitHub Actions | `vault auth enable jwt` → OIDC token from GitHub             |
| Any server     | `vault auth enable approle` → role_id + secret_id from CI/CD |

The NestJS code (`VaultService`) stays exactly the same — only the token acquisition method changes.

`VaultService` also implements:

- **AppRole auth** — `VAULT_ROLE_ID` + `VAULT_SECRET_ID` → scoped short-lived token (enabled by default in `infra/vault/init.sh`)
- **Token auto-renewal** — `token.renewSelf()` every 1/3 of TTL so the app stays authenticated past the initial token lifetime
- **Transit engine** — `encrypt()` / `decrypt()` for encryption-as-a-service; PII (e.g. email) in the ClickHouse audit log is encrypted via `transit/keys/user-data` so the key never leaves Vault
- **Dynamic PostgreSQL credentials** — `getDynamicDbCredentials()` fetches a temporary DB user (TTL=1h) from `database/creds/tropis-app`; `PostgresModule` uses these at startup instead of the static `POSTGRES_USER`/`POSTGRES_PASSWORD`

### Manual Vault CLI

```bash
# Enter the Vault container
docker exec -it tropis_vault sh

# Set token
export VAULT_TOKEN=dev-root-token

# Read all secrets
vault kv get secret/tropis

# Read a specific group
vault kv get secret/tropis/auth

# Update a secret (e.g. rotate JWT secret)
vault kv patch secret/tropis JWT_SECRET=new-super-secret-value

# Check app token permissions
vault token lookup <app-token>
```

---

## Shared package

`packages/shared` (`@tropis/shared`) — a compiled TypeScript library imported by both the backend and frontend. Code lives here only when both sides must agree on a contract (response envelope types, pagination shapes, event contracts, error codes, the tracking dictionary) — promotion rules in [docs/project-structure.md](docs/project-structure.md) (three-tier placement).

```typescript
import {
  ApiResponse,
  AppEvent,
  EVENT_TYPES,
  PaginatedResult,
} from '@tropis/shared';
```

---

## Flink stream pipeline

**Flow:** Pulsar analytics topic → Flink job → ClickHouse

The Flink cluster (JobManager + TaskManager) lives behind the `analytics` compose profile — start it with `make up-analytics` (or `make up-all`). The job JAR must be built and submitted separately — it is not auto-submitted on container start.

```bash
# Option A — one command from repo root (auto-detects mvn or falls back to Docker build)
bash flink/submit-job.sh

# Option B — Makefile (requires mvn installed locally)
make -C flink init-ch    # create ClickHouse table (run once, before first submit)
make -C flink submit     # mvn package → upload JAR → run job
make -C flink logs       # tail Flink TaskManager logs
```

After submitting, open the Flink Web UI → http://localhost:8081 and verify the job shows status **RUNNING**.

> **No Maven installed?** `submit-job.sh` automatically falls back to `docker run maven:3.9-eclipse-temurin-11` for the build step. First run downloads the Maven image (~500 MB).

> **ClickHouse tables must exist first.** Run `make -C flink init-ch` or the ClickHouse init scripts before submitting the job, otherwise the Flink job will fail to write output.

---

## OpenTelemetry tracing

`tracing.ts` is loaded first in `main.ts`. Registers:

- OTLP HTTP exporter → OTel Collector (`:4318`) → Jaeger + Prometheus
- Auto-instrumentations: HTTP, MongoDB, Redis, gRPC (zero manual code needed)

View traces: Jaeger UI → http://localhost:16686 — search by service `nestjs-app`.

---

## Prometheus metrics

NestJS exposes `/api/metrics` (Prometheus text format) via `@willsoto/nestjs-prometheus`. Three custom metrics are registered:

- `http_requests_total` — counter, labelled by method / route / status code
- `http_request_duration_seconds` — histogram, same labels
- `queue_jobs_total` — counter labelled by queue name and job name

Prometheus scrapes this endpoint every 15 s and stores the data. Grafana then queries Prometheus to build dashboards.

---

## Environment variables

All variables are validated by `config/env.validation.ts` (Joi) on startup. The app exits immediately with a descriptive error if any required variable is missing or fails validation — no silent misconfiguration.

Copy `.env.example` to `.env` to get started:

```bash
cp apps/backend/.env.example apps/backend/.env
```

**`apps/backend/.env.example` is the authoritative, always-current variable list** (one entry per datastore/broker/tool, matching the port map above). New vars must be added there AND to the Joi schema. The ones worth understanding rather than copying:

```env
# Refuses to start if missing or < 32 chars (Joi min(32).required())
JWT_SECRET=change-me-in-production

# Host port 27018 (compose maps 27018:27017). replicaSet=rs0 is REQUIRED —
# the outbox pattern needs transactions, which need a replica set.
MONGODB_URI=mongodb://127.0.0.1:27018/tropis?replicaSet=rs0&directConnection=true

# Broker selection behind MessageBrokerPort (src/infrastructure/messaging/)
MESSAGE_BROKER=pulsar

# Request signing + internal gRPC tier (docs/api-conventions.md)
API_KEYS={}        # JSON map {keyId: secret}
SERVICE_TOKEN=     # unset ⇒ internal tier disabled

# Leave blank to skip Vault and read .env directly (see Vault section)
VAULT_ADDR=
VAULT_TOKEN=

# OAuth2 / SSO — leave blank to disable a provider
GOOGLE_CLIENT_ID= / GITHUB_CLIENT_ID= (+ secrets & callback URLs)

# Multi-tenancy fallback tenant
DEFAULT_TENANT=default
```

`apps/frontend/helm/.env`:

```env
# gRPC-Web endpoint (Envoy proxy)
VITE_GRPC_WEB_URL=http://localhost:8090
# WebSocket (Socket.io) endpoint — backend HTTP port
VITE_WS_URL=http://localhost:3100
# REST base URL — bare origin, WITHOUT /api (the SDK appends /api itself)
VITE_API_BASE_URL=http://localhost:3100
```

---

## API reference

**This project is gRPC-first for business logic.** REST (`/api` / `/api/v1`) fills only the gaps gRPC handles poorly (see `docs/architecture.md`): infrastructure endpoints, OAuth callbacks, and the tracking beacon ingest.

### HTTP endpoints (gap-fillers)

```
GET  /api/health                Liveness/readiness probe — returns { status, info: { mongo, redis, ... } }
GET  /api/metrics               Prometheus text metrics — scraped every 15s by Prometheus container
POST /api/auth/login            JWT login (+ refresh/logout endpoints)
GET  /api/auth/google[/callback]   OAuth2 (also /api/auth/github[/callback])
POST /api/v1/track              Tracking beacon ingest — public, rate-limited, returns 202
```

Swagger UI: `http://localhost:3100/api/docs` (non-production only).

### gRPC endpoints — `localhost:50051`

All business logic is exposed via gRPC. **The contracts in `proto/<domain>/v1/`
are the single source of truth** for every service, method, and field —
buf-linted and breaking-change-gated in CI, so they cannot drift. Domains at a
glance: auth (login/JWT), user (CRUD + Elasticsearch search + pgvector
similarity), analytics (events + stats), tracking (behavior insights), health;
plus `tropis.signing.v1` served by the Rust signing service on `:50052`
(`services/rust/signing/README.md`). The internal tier (`app.*.internal.v1`)
listens separately on `:50061` — see [docs/api-conventions.md](docs/api-conventions.md).

To browse the API: read the proto files (they are short and commented), or use
the typed SDK (`packages/sdk`) which mirrors every public RPC.

---

## Deploying to cloud

This project runs entirely on Docker Compose locally. The same workloads can be deployed to any major cloud with the changes listed below.

### Cloud provider options

| Cloud     | Kubernetes | Managed services you can swap in                                                                                                                                      |
| --------- | ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **AWS**   | EKS        | RDS (PostgreSQL), ElastiCache (Redis), MSK (Kafka/replace Pulsar), OpenSearch (replace ES), S3 (replace MinIO), SES (replace MailHog SMTP), SNS/SQS (replace BullMQ)  |
| **GCP**   | GKE        | Cloud SQL, Memorystore, Pub/Sub (replace Pulsar), Elasticsearch (via Elastic Cloud), Cloud Storage (replace MinIO), SendGrid                                          |
| **Azure** | AKS        | Azure Database for PostgreSQL, Azure Cache for Redis, Event Hubs (replace Pulsar), Azure Cognitive Search, Blob Storage (replace MinIO), Azure Communication Services |

You do not need to replace everything. Swap only what makes operational sense — MinIO → S3 and MailHog → SES are the easiest wins. MongoDB, ClickHouse, and Pulsar are all available as managed services (MongoDB Atlas, ClickHouse Cloud, StreamNative).

---

### Kubernetes

Manifests live in `infra/k8s/` as a kustomize **base** (`base/` — namespace, networkpolicy, backend/frontend Deployments, Services, ConfigMap, dev Secret, PDBs) plus a prod overlay (`overlays/prod/` — HPA + ingress):

```bash
# dev / base
kubectl apply -k infra/k8s

# production
kubectl apply -k infra/k8s/overlays/prod
```

**Before deploying to a real cluster, you must:**

1. **Push images to a registry** — build and push the backend image to ECR / GCR / ACR, then update `image:` in `infra/k8s/base/backend/deployment.yaml`.

   ```bash
   # Example — AWS ECR
   docker build -f apps/backend/Dockerfile -t 123456789.dkr.ecr.ap-southeast-1.amazonaws.com/tropis-backend:latest .
   docker push 123456789.dkr.ecr.ap-southeast-1.amazonaws.com/tropis-backend:latest
   ```

2. **Replace hardcoded secrets** — never put `.env` values into Kubernetes manifests. Use one of:

   | Approach                                   | When to use                                                                                                                                       |
   | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- |
   | **Kubernetes Secrets**                     | Simple clusters, low security requirements — base64-encoded, stored in etcd                                                                       |
   | **External Secrets Operator**              | Syncs secrets from AWS Secrets Manager / GCP Secret Manager / Azure Key Vault into K8s Secrets automatically                                      |
   | **HashiCorp Vault** (already in this repo) | Already set up — enable `vault auth enable kubernetes` and the app's `VaultService` fetches secrets at startup without any secret in the manifest |

3. **Configure an Ingress controller** — expose the frontend and backend HTTP ports externally. Common options: NGINX Ingress Controller, AWS ALB Ingress Controller, Traefik.

   ```yaml
   # Example — NGINX Ingress for the backend
   apiVersion: networking.k8s.io/v1
   kind: Ingress
   metadata:
     name: backend-ingress
     annotations:
       nginx.ingress.kubernetes.io/rewrite-target: /
   spec:
     rules:
       - host: api.yourdomain.com
         http:
           paths:
             - path: /
               pathType: Prefix
               backend:
                 service:
                   name: backend-service
                   port:
                     number: 3100
   ```

4. **Set up TLS** — use cert-manager with Let's Encrypt or your cloud's managed certificate service. Add a `Certificate` resource pointing at your Ingress.

5. **Point services at managed infrastructure** — update your env vars / Vault secrets to use cloud endpoints instead of Docker Compose service names:

   | Local (`docker-compose`) | Cloud replacement                                           |
   | ------------------------ | ----------------------------------------------------------- |
   | `mongodb:27017`          | `cluster.mongodb.net` (Atlas) or self-hosted on K8s         |
   | `redis:6379`             | `your-cluster.cache.amazonaws.com` (ElastiCache)            |
   | `postgres:5432`          | `your-db.rds.amazonaws.com` (RDS)                           |
   | `elasticsearch:9200`     | Elastic Cloud endpoint or self-hosted                       |
   | `minio:9900`             | `s3.amazonaws.com` (change `MINIO_ENDPOINT` to S3 endpoint) |
   | `pulsar:6650`            | StreamNative Cloud or self-hosted                           |

---

### Key things to change for production

| Item            | Local dev                      | Production                                                           |
| --------------- | ------------------------------ | -------------------------------------------------------------------- |
| **JWT_SECRET**  | `change-me-in-production`      | Random 64-char string in Vault / Secrets Manager                     |
| **MongoDB**     | Single-node replica set        | Atlas M10+ or 3-node replica set with auth                           |
| **Redis**       | No auth                        | AUTH password + TLS                                                  |
| **PostgreSQL**  | No SSL (`POSTGRES_SSL=false`)  | `POSTGRES_SSL=true` + certificate                                    |
| **MinIO**       | Self-signed, no TLS            | Replace with S3 or enable TLS on MinIO                               |
| **SMTP**        | MailHog (local trap)           | AWS SES / SendGrid / Postmark                                        |
| **OPA**         | Open, no auth                  | Add API key or deploy as a sidecar                                   |
| **Vault**       | Dev mode (no persistence)      | Vault in production mode with HA + auto-unseal                       |
| **CORS_ORIGIN** | `http://localhost:5173`        | Your actual frontend domain                                          |
| **NODE_ENV**    | `development`                  | `production` (disables Swagger, enables JSON logs)                   |
| **Log drain**   | Console (Pino pretty-print)    | Loki / CloudWatch / Datadog (Pino ships raw JSON in prod)            |
| **Metrics**     | Prometheus + Grafana in Docker | Prometheus Operator on K8s or cloud-native (CloudWatch, Stackdriver) |
| **Tracing**     | Jaeger in Docker               | AWS X-Ray / Google Cloud Trace / Datadog APM (swap OTLP exporter)    |

---

### Horizontal scaling notes

The backend is stateless and safe to run multiple replicas behind a load balancer, **with one caveat per module**:

| Module                          | Multi-replica behaviour                                                                                                                  |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| **OutboxRelay**                 | Uses Redis distributed lock (NX, 8 s TTL) — only one replica relays at a time. Safe.                                                     |
| **BullMQ**                      | Workers compete for jobs via Redis atomic `BRPOPLPUSH` — safe to scale.                                                                  |
| **WebSockets**                  | Socket.io rooms are in-process — add Redis adapter (`@socket.io/redis-adapter`) so sockets on different replicas can message each other. |
| **Temporal worker**             | Scale independently — more workers = more concurrent workflow tasks.                                                                     |
| **Feature flags / idempotency** | Both in Redis — safe across replicas.                                                                                                    |

### Minimal cloud deploy checklist

- [ ] Container images built and pushed to a registry
- [ ] Kubernetes namespace created
- [ ] Secrets loaded into Vault or External Secrets Operator (no plaintext secrets in manifests)
- [ ] PersistentVolumeClaims or managed DB services provisioned
- [ ] Ingress controller installed and DNS pointed at the load balancer
- [ ] TLS certificates issued (cert-manager or cloud-managed)
- [ ] HorizontalPodAutoscaler configured for backend and frontend
- [ ] Liveness/readiness probes wired to `/api/health` (already implemented)
- [ ] Socket.io Redis adapter added if running > 1 backend replica
- [ ] `NODE_ENV=production` set (disables Swagger, switches to JSON logs)
- [ ] `SONAR_TOKEN` added to GitHub repo secrets for SonarCloud CI gate

---

### Branch strategy and environments

Most teams map git branches directly to environments:

```
dev     branch  →  DEV environment   (auto-deploy on every push)
main    branch  →  QA  environment   (auto-deploy on merge to main)
v*      tag     →  PROD environment  (deploy on git tag, e.g. v1.2.3)
```

**How it works in practice:**

1. Developers push feature branches and open PRs into `dev`. CI runs on every PR.
2. `dev` merges into `main` → auto-deploys to QA so testers can verify.
3. When QA signs off, a git tag is created → prod deploy triggers.

This repo follows this pattern. `.github/workflows/ci.yml` runs on `main` and `develop`. `.github/workflows/deploy-prod.yml` triggers only on `v*` tags.

---

### What to fill in after prod deploy

The K8s manifests and deploy workflow contain placeholders. Replace these before going live:

**In `infra/k8s/overlays/prod/kustomization.yaml`:**

- `CORS_ORIGIN=https://yourdomain.com` → your real frontend domain

**In `infra/k8s/overlays/prod/ingress.yaml`:**

- `yourdomain.com` → your frontend domain (×2 — in `tls.hosts` and `rules.host`)
- `api.yourdomain.com` → your backend API domain (×2)
- `ingressClassName: nginx` → change to `alb` or `traefik` if not using NGINX

**In `infra/k8s/base/backend/deployment.yaml`:**

- `ghcr.io/tropis/backend:latest` → your actual registry path (e.g. `ghcr.io/yourorg/backend`)

**In `infra/k8s/base/frontend/deployment.yaml`:**

- `ghcr.io/tropis/frontend:latest` → your actual registry path

**GitHub repo secrets (Settings → Secrets → Actions):**

| Secret              | What to put                                                                    |
| ------------------- | ------------------------------------------------------------------------------ |
| `KUBE_CONFIG`       | Your cluster kubeconfig, base64-encoded: `kubectl config view --raw \| base64` |
| `PROD_API_BASE_URL` | `https://api.yourdomain.com/api`                                               |
| `PROD_WS_URL`       | `https://api.yourdomain.com`                                                   |
| `SONAR_TOKEN`       | From sonarcloud.io after linking your GitHub org                               |

**In Vault (prod namespace):**

- Rotate all secrets from their dev defaults — especially `JWT_SECRET`, DB passwords, MinIO keys
- Enable `vault auth enable kubernetes` so pods authenticate with their service account instead of a static token

---

### GitOps — the industry standard

Most companies at scale do **not** keep K8s manifests or deploy workflows inside the app repo. The reason is separation of concerns — the app team owns the code, the platform/infra team owns the deployment config.

**The GitOps pattern:**

```
┌─────────────────────┐        push image tag        ┌──────────────────────┐
│   my-app  (code)    │ ─────────────────────────▶   │  my-app-infra (K8s)  │
│                     │                               │                      │
│  ci.yml runs tests  │                               │  ArgoCD / Flux       │
│  builds Docker image│                               │  watches this repo   │
│  pushes to registry │                               │  syncs to cluster    │
└─────────────────────┘                               │  automatically       │
                                                      └──────────────────────┘
```

1. **App repo** — contains only application code + CI (test, build, push image). No K8s YAML.
2. **Infra repo** — contains Helm charts or Kustomize overlays. No application code.
3. **ArgoCD or Flux** — runs inside the cluster, watches the infra repo. When a new image tag is committed, it automatically applies the change to the cluster.

**Why this is better than `kubectl apply` in CI:**

| `kubectl apply` in CI (what this repo does)          | ArgoCD / Flux (GitOps)                                     |
| ---------------------------------------------------- | ---------------------------------------------------------- |
| Simple, no extra tooling                             | Requires ArgoCD/Flux installed in cluster                  |
| CI needs direct cluster access (risky)               | Cluster pulls from git — no inbound access needed          |
| Drift goes undetected (someone `kubectl edit`s live) | Any manual change is overwritten — git is always the truth |
| No rollback UI                                       | Full rollback via `git revert`, visible in ArgoCD UI       |
| Good for small teams and learning projects           | Standard in mid-to-large engineering orgs                  |

**Why this repo keeps the manifests and deploy workflow here:**

This is a portfolio / learning project. Splitting into two repos would hide half the architecture from anyone reading the code. Keeping everything in one place shows the full picture — what the manifests look like, how the deploy pipeline works, what secrets are needed. In a real org you would extract `infra/k8s/` into its own repo and replace `deploy-prod.yml` with a workflow that only updates the image tag in the infra repo.

---

## CI / CD

`.github/workflows/ci.yml` runs on push to `main` / `develop` and on every PR. All jobs block merge on failure. Jobs cover lint/type/test/build per workspace, architecture checks, integration (Testcontainers), Rust, browser E2E, Docker image build + scan + SBOM, license checks, proto lint/breaking, secret scanning, SAST, and SonarCloud quality gate — see the workflow file for the current job list.

### Coverage thresholds (enforced in `backend` job)

Coverage is collected from `*.service.ts`, `*.gateway.ts`, `*.repository.ts` only.

| Metric     | Threshold |
| ---------- | --------- |
| Lines      | ≥ 70%     |
| Statements | ≥ 70%     |
| Branches   | ≥ 60%     |
| Functions  | ≥ 60%     |

### Dependabot (`.github/dependabot.yml`)

Opens weekly, grouped update PRs per ecosystem (npm workspaces, Maven/Flink, GitHub Actions) — groups and exclusions live in the config file. Major version bumps are excluded from automation and require manual review.

### SonarCloud setup (one-time)

1. Sign up at [sonarcloud.io](https://sonarcloud.io) and link your GitHub org
2. Create a project, copy the token
3. Add `SONAR_TOKEN` in repo **Settings → Secrets → Actions**
4. The `sonarcloud` CI job reads `sonar-project.properties` and the LCOV coverage report generated by the `backend` job

---

## Testing

```bash
# Backend (Jest) — run inside apps/backend or with --filter @tropis/backend
pnpm test            # all Jest unit tests (no coverage)
pnpm test:cov        # with coverage report + threshold check
pnpm test:int        # integration suite (Testcontainers — needs Docker only); or `make test-int`
pnpm test:e2e        # Jest e2e (requires running infrastructure)

# Browser E2E (Playwright, from repo root)
pnpm test:e2e        # root script → @tropis/e2e playwright test (backend+frontend must be running)
make test-e2e        # full-stack: compose up + Jest e2e + Playwright + teardown

# Frontend (Vitest)
cd apps/frontend/helm
pnpm test            # run all Vitest tests once
pnpm test:watch      # run tests in watch mode
pnpm test:coverage   # run tests and generate coverage report
cd ..
```

### Test files

Unit tests live in `__tests__/` folders next to the code they test (placement rules in [docs/project-structure.md](docs/project-structure.md)) — run `make test`. Integration tests (Testcontainers) live in `apps/backend/test/integration/`; browser E2E lives in `e2e/`.

### E2E tests (`test/app.e2e-spec.ts`)

Requires all Docker infrastructure running. Uses the same `ValidationPipe` and `setGlobalPrefix` config as `main.ts` so it exercises the real request pipeline (health/metrics endpoints + gRPC auth and user flows).

```bash
# Start infra first
docker compose -f infra/docker/docker-compose.yml up -d

# Run e2e suite
pnpm test:e2e
```

---

## Docker — application image

`apps/backend/Dockerfile` — multi-stage build for the NestJS application itself (separate from the infra `docker-compose.yml`).

```bash
# Build the image
docker build -f apps/backend/Dockerfile -t tropis-backend:latest .

# Run it (requires infra containers already running)
docker run -p 3100:3100 -p 50051:50051 \
  --env-file apps/backend/.env \
  tropis-backend:latest
```

**Build stages:**

1. **builder** — installs all deps, compiles `@tropis/shared` then `@tropis/backend`, output in `dist/`
2. **runner** — fresh `node:22-alpine`, production deps only, copies compiled output, runs as non-root user (`appuser`)

The image exposes ports `3100` (HTTP + WebSocket) and `50051` (gRPC). Update the image name in `infra/k8s/base/backend/deployment.yaml` before deploying to Kubernetes.
