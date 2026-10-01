# Architecture

Tropis is a foundation for building products: it provides authentication, users, multi-tenancy, a transactional outbox, an event bus, operational and analytical stores, durable workflows, observability, security fences and CI-enforced layering. On top of those capabilities it ships one product slice — product analytics (tracking → Pulsar → ClickHouse → live dashboard) — as the reference workload that exercises every capability end to end. This document describes how the pieces fit together; folder layout and layering rules are in [project-structure.md](project-structure.md), and the reasoning behind each technology choice is in [tech-decisions.md](tech-decisions.md).

## Components

| Component                         | Location                                                                  | Role                                                                                                                                                                                                                                                                                                                                                                                           |
| --------------------------------- | ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Backend**                       | `apps/backend/`                                                           | One NestJS codebase run as four roles ([Backend roles](#backend-roles)): `public` (HTTP on `PORT` 3100 under `/api`, public RPC `RPC_PUBLIC_PORT` 50051, Socket.io namespace `/ws`), `private` (internal RPC `RPC_INTERNAL_PORT` 50061), `worker` and `scheduler`; each RPC port serves Connect, gRPC and gRPC-Web, and every role serves health and metrics on the ops port `OPS_PORT` (9464) |
| **Temporal worker**               | `apps/backend/src/infrastructure/workflow/`                               | Runs in the backend's worker role (`WorkflowWorkerModule.forRoot()`, `adapters/temporal/temporal-worker.service.ts`): one Temporal worker per queue a module registers with `WorkflowWorkerModule.forFeature`. The adapter holds no workflow of its own; the onboarding workflow and its activities live in `modules/user/workflows/` (task queue `user-onboarding`)                           |
| **Frontend — helm (the console)** | `apps/frontend/helm/`                                                     | Logged-in console. React 18 + Vite SPA, served as a static nginx image. Pages: `/analytics`, `/users`, `/stack` (System Map), `/behavior`. Calls the backend's public RPC listener directly over the Connect protocol, REST for files/auth, Socket.io for live updates                                                                                                                         |
| **Frontend — harbor**             | `apps/frontend/harbor/`                                                   | Public site. Next.js 15 App Router (SSR/SSG), shipped as a standalone Node server                                                                                                                                                                                                                                                                                                              |
| **Native shells**                 | `apps/desktop/`, `apps/frontend/helm/android/`, `apps/frontend/helm/ios/` | Tauri v2 desktop shell and Capacitor Android/iOS projects wrapping the built helm bundle (see [project-structure.md](project-structure.md))                                                                                                                                                                                                                                                    |
| **Shared package**                | `packages/shared/`                                                        | Types, DTOs, error codes and event contracts (`EVENT_TYPES`, `ANALYTICS_EVENT_TYPES`, the user events contract in `events/user-events.ts`) shared by backend and frontends                                                                                                                                                                                                                     |
| **Client SDK**                    | `packages/sdk/`                                                           | `@tropis/sdk`: Connect RPC client, REST helpers, realtime (Socket.io) client, tracking SDK, HMAC request-signing module; buf-generated proto types in `src/gen/`                                                                                                                                                                                                                               |
| **Proto contracts**               | `proto/`                                                                  | `auth`, `user` (+ `user/internal`), `analytics`, `tracking`, `health`, `signing` — one `v1` package per domain                                                                                                                                                                                                                                                                                 |
| **Rust services**                 | `services/rust/signing/`                                                  | Member of the Cargo workspace at the repo root (`Cargo.toml`); `signing` is a gRPC service (`tropis.signing.v1.SigningService`, port 50052, compose profile `signing`)                                                                                                                                                                                                                         |
| **Flink job**                     | `services/flink/`                                                         | Java/Maven. `PulsarToClickHouseJob` streams the analytics topic into `logs.analytics_events` when `STREAM_ENGINE=flink`                                                                                                                                                                                                                                                                        |
| **Local infra**                   | `infra/docker/docker-compose.yml`                                         | MongoDB, Redis, Pulsar, OPA and Mailpit in the core set; every other capability behind a profile named after it (`relational`, `search`, `olap`, `objects`, `workflow`, `secrets`, `kv-scale`, `graph`, `kafka`, `stream` for Flink, `signing`, `observability`, `tools` for admin UIs). Ports and commands: [development.md](development.md)                                                  |
| **Kubernetes**                    | `infra/k8s/`, `infra/argocd/`                                             | Kustomize base (backend, `frontend/` for helm, harbor, backup, NetworkPolicy) with `overlays/staging` and `overlays/prod`; Argo CD applications for dev (the base) and prod, with staging as a commented-out template. See [deployment.md](deployment.md)                                                                                                                                      |
| **CI/CD**                         | `.github/workflows/`                                                      | `ci.yml` (every check, including a backend image build per role: [CONTRIBUTING.md](../CONTRIBUTING.md#ci-checks)), `deploy-prod.yml` (per-role backend images and the frontend images to GHCR, then the K8s deploy, on a semver tag), `publish.yml`, `release-please.yml`                                                                                                                      |

Outside `apps/`, helm's container image, Kubernetes Deployment (`frontend`, Service `frontend-svc`) and CI job are named `frontend`.

## The spine: one event's journey

Tropis is event-driven. The reference workload follows one analytics event from the API to a live chart; every hop is a real component:

```
RPC AnalyticsService.CreateEvent  (browser → backend :50051, Connect protocol)
  → authentication interceptor  TokenVerifier (JWT, revocation, membership)
  → authorization interceptor   @Authorize('analytics', action) → POLICY port → OPA allow
  → AnalyticsService.create()   one MongoDB transaction:
        EventLog document  +  outbox row (topic analytics-events, status pending)
  → OutboxRelay (worker role, every 5 s, per-aggregate lease)  → MESSAGING port → Pulsar
        topic analytics-events (persistent://public/default/analytics-events)
  ├─► AnalyticsProcessor (sub analytics-processor-sub)
  │     DEDUP claim on the domain eventId
  │     → ClickHouse logs.analytics_events
  │          └─ materialized view → logs.analytics_minutely_agg (per-minute counts)
  │     → REALTIME.publishToRoles(admin, editor, viewer, 'analytics.event')  → helm /analytics updates live
  │     (only with STREAM_ENGINE=node, the default)
  └─► Flink PulsarToClickHouseJob (sub flink-clickhouse-sub, only with STREAM_ENGINE=flink)
        → ClickHouse logs.analytics_events, in place of AnalyticsProcessor
  → reads: AnalyticsService.GetStats (cached 30 s), GetMinutelyStats (ClickHouse);
           GetRecent (MongoDB event log)
```

The same shape — transactional write, outbox, Pulsar, idempotent consumer, read model — is what the user module uses for its durable side effects (see [Request → response flow](#request--response-flow-user-create)).

## Technology map

Each technology is classified by how the running code uses it.

### Used on every request or event

| Technology            | Job                                                                                                                                                                                                                                                                                                                                                                     |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| NestJS backend        | All business logic, every transport                                                                                                                                                                                                                                                                                                                                     |
| MongoDB (replica set) | System of record: users, `tenants` (the tenant directory), `user_event_store`, `outbox`, analytics event log. Transactions make the domain write and outbox row atomic                                                                                                                                                                                                  |
| Redis                 | Behind the `cache`, `lock`, `ratelimit` and `dedup` ports (user profile, tenant record and stats cache, outbox aggregate leases, login, sign-up and HTTP throttler counters, consumer and nonce dedup claims), the `kv` port by default (token revocations, refresh tokens, suspension markers, sessions, idempotent responses), BullMQ, and the realtime Redis adapter |
| Pulsar                | Event bus behind the `MESSAGING` port (logical topics `user-events`, `analytics-events`, `tracking-events`, mapped to `persistent://public/default/<topic>`); `MESSAGING_ADAPTER=pulsar` is the default, `kafka` and `disabled` the alternatives                                                                                                                        |
| ClickHouse            | Append-only analytics store: `analytics_events`, `analytics_minutely_agg`, `user_behavior`, `audit_log`                                                                                                                                                                                                                                                                 |
| OPA                   | Role → resource → action decision on every authorized RPC call and on the REST role endpoints                                                                                                                                                                                                                                                                           |
| Socket.io             | Live push to the console (`analytics.event`, `tracking.event`, `user.created`, `user.updated`, `notification`)                                                                                                                                                                                                                                                          |
| helm (React + Vite)   | The console that reads all of the above                                                                                                                                                                                                                                                                                                                                 |

### Used by a specific feature

| Technology                  | Feature                                                                                                                                                                                         |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Elasticsearch               | `UserService.Search` — full-text user search; index `users` maintained by `UserProcessor`                                                                                                       |
| PostgreSQL + pgvector       | `UserService.FindSimilar` — 384-dimension embeddings in the `vector_embeddings` table (collection `user-profile`, IVFFlat cosine index) behind the `VECTOR` port, maintained by `UserProcessor` |
| MinIO                       | User avatar upload and signed download URLs (`POST /api/users/:id/avatar`, `GET /api/users/:id/avatar-url`)                                                                                     |
| BullMQ + SMTP (Mailpit dev) | Behind the `JOBS` and `MAIL` ports: welcome email on user creation (`notification` queue), the outbox sweep (`outbox-maintenance`) and the `dead-letter` queue                                  |
| Temporal                    | `userOnboardingWorkflow` — durable follow-up started per new user; status read by `GET /api/workflows/onboarding` (admin)                                                                       |
| Vault                       | Behind the `SECRETS` port (`SECRETS_ADAPTER=vault`): secret loading into the environment before config validation and dynamic PostgreSQL credentials (all only when `VAULT_ADDR` is set)        |
| Aerospike                   | The `kv` port's alternative adapter (`KV_ADAPTER=aerospike`), for key/value data that outgrows Redis memory; off by default                                                                     |
| harbor (Next.js)            | Public marketing/content site                                                                                                                                                                   |

### Used for operations

| Technology                       | Job                                                                                                                |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| OpenTelemetry Collector → Jaeger | Distributed traces                                                                                                 |
| Prometheus + Alertmanager        | Metrics scrape and alert rules (`infra/prometheus/`)                                                               |
| Grafana                          | Dashboards over Prometheus (`infra/grafana/provisioning/`, `infra/grafana/dashboards/`)                            |
| Kubernetes (kustomize) + Argo CD | Deployment and GitOps ([deployment.md](deployment.md))                                                             |
| `tools` profile admin UIs        | mongo-express, clickhouse-ui, pulsar-manager, grpcui, pgAdmin, Kibana, RedisInsight, Dozzle, Temporal UI, Metabase |

### Available, with a reference use only

| Technology             | What exists                                                                                                                                                                                                                                                                                                                     |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Flink                  | `PulsarToClickHouseJob` consumes `analytics-events` on its own subscription and writes `logs.analytics_events` when the backend runs with `STREAM_ENGINE=flink` (the Node `AnalyticsProcessor` then does not subscribe). Submitted manually (`services/flink/submit-job.sh`), not on container start                            |
| Neo4j (graph)          | `features/membership-graph/` projects `user.created`/`user.updated`/`user.deleted` into `(User)-[:MEMBER_OF]->(Tenant)` and `(User)-[:INVITED]->(User)` and answers `membersOf()` and `invitationChain()` through the `GRAPH` port. Off unless `GRAPH_ADAPTER=neo4j`; with the graph disabled the projection does not subscribe |
| Rust `signing` service | Computes and verifies HMAC-SHA256 request signatures byte-for-byte compatible with the TypeScript implementation. `SignatureGuard` verifies through the `SIGNING` port: in process by default (`SIGNING_ADAPTER=inprocess`), through this service with `SIGNING_ADAPTER=native`                                                 |

### System Map

The helm `/stack` page (`features/stack/`) lists every technology grouped by category (services, data, streaming, observability, security, delivery), with a live up/down state from `GET /api/health` (polled every 10 s), a link to each tool's console, and Temporal's running/completed onboarding counts.

## Architectural rules

| Rule                                                                                                                                                                                   | Why                                                                                                                                                                                                                                                                                               |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Domain events are published only through the outbox, written in the same MongoDB transaction                                                                                           | A crash between a DB commit and a broker publish would otherwise lose the event                                                                                                                                                                                                                   |
| Durable side effects run in Pulsar consumers; in-process `EventEmitter2` handlers only do ephemeral work (WebSocket pushes)                                                            | A consumer is retried on failure; an in-process handler is lost if the process dies after the commit                                                                                                                                                                                              |
| Every consumer is idempotent (a `DEDUP` claim on the event id, released on failure so the redelivery retries) ([Idempotent consumers](#idempotent-consumers-replay-safe-side-effects)) | Delivery is at-least-once and ClickHouse MergeTree does not deduplicate                                                                                                                                                                                                                           |
| Business code reaches every external system only through a capability port (`src/infrastructure/<capability>/<capability>.port.ts`)                                                    | Keeps vendors swappable and business code testable. dependency-cruiser in CI lets only capability adapters and shared connections import driver packages at runtime, and blocks modules from importing adapters or connections; the rule table is in [project-structure.md](project-structure.md) |
| RPC first; REST only where RPC cannot serve the caller                                                                                                                                 | One contract (`proto/`) generates server stubs and the SDK                                                                                                                                                                                                                                        |
| Every tenant-scoped read and write carries `tenantId`, enforced by each store's adapter ([Multi-tenancy](#multi-tenancy))                                                              | Tenants share collections and tables; the filter is the isolation boundary                                                                                                                                                                                                                        |

## Data flow

```
                ┌──────────────────────────── Browser (helm) ────────────────────────────┐
                │  Connect ───► backend RPC :50051 (public tier)                         │
                │  REST ──────► backend HTTP :3100 /api  (files, auth, tracking ingest)  │
                │  Socket.io ◄─ backend /ws namespace (JWT at connect)                   │
                └───────────────────────────────────────┬────────────────────────────────┘
                                                        │
   ┌────────────────────────────────── NestJS backend ──┴─────────────────────────────────┐
   │  controllers (REST + RPC)  ─► services ─► repositories                               │
   │        │                          ├─► MongoDB     users, event store, outbox, logs   │
   │        │                          ├─► Redis       cache, kv, locks, limits, dedup    │
   │        │                          ├─► PostgreSQL  pgvector vector_embeddings         │
   │        │                          ├─► Elasticsearch  users index                     │
   │        │                          ├─► MinIO       avatars                            │
   │        │                          ├─► Aerospike   kv (KV_ADAPTER=aerospike)          │
   │        │                          ├─► ClickHouse  audit_log, analytics, tracking     │
   │        │                          └─► OPA         authorization decisions            │
   │  OutboxRelay ─► MESSAGING ─► Pulsar ─► EventConsumer subscribers ─► ClickHouse/ES/PG │
   │  TrackingService ─► Pulsar (direct) ─► TrackingProcessor ─► ClickHouse               │
   │  BullMQ (notification, outbox-maintenance, dead-letter) ─► SMTP                      │
   │  Temporal client (public, worker) + workers (worker role) ─► Temporal server         │
   │  internal RPC :50061 (tropis.user.internal.v1) — ClusterIP only                      │
   └──────────────────────────────────────────────────────────────────────────────────────┘
                              │
                              ▼
            Pulsar analytics-events ──► Flink ──► ClickHouse logs.analytics_events   (STREAM_ENGINE=flink)
```

## Transport strategy

RPC over the proto contracts is the primary transport. Every business operation is an RPC method (protos in `proto/<domain>/v1/`, handlers in `modules/<module>/controllers/` or `features/<feature>/controllers/` as `*.rpc.controller.ts` decorated with `@RpcService`, shared plumbing in `src/infrastructure/rpc/`). `RpcServer` serves Connect, gRPC and gRPC-Web on each listener port, speaking HTTP/1.1 and h2c on one TCP port (`rpc-listener.ts`); the browser calls the public listener directly with the Connect protocol, and CORS for it is applied in `rpc-cors.ts`. Which tier (public :50051 or internal :50061) an RPC lives on is decided by its proto path (`proto/**/internal/**` is internal, every other contract public; the `tiers` option of `@RpcService` overrides it): each listener routes only the services of its tier; tier rules and service identity are in [api-conventions.md](api-conventions.md).

REST (under `/api`) serves only callers RPC cannot serve: uploads, OAuth redirects, browser session endpoints, beacons, probes and scrapes, and operator UIs. The full list and the reason for each entry are in [api-conventions.md](api-conventions.md#transport-choice).

WebSocket (Socket.io, `modules/websocket/gateways/notification.gateway.ts`) carries server-to-browser pushes. The handshake token goes through the shared `TokenVerifier`; a socket joins only its tenant room `t.<tenantId>`, its user room `t.<tenantId>:user:<userId>` and one role room `t.<tenantId>:role:<role>` per role of its member record. It is disconnected by a timer at the token's `exp`, and a 60 s sweep re-verifies the sockets the process holds (revocation, account status, membership, token version, tenant status), 20 at a time so a sweep cannot flood the stores, and moves each socket to the role rooms of its current roles; a tick that finds the previous sweep still running is skipped. Only a failure that ends the session (an `AUTH_*` code or `TENANT_INACTIVE`) disconnects; a store outage (`SERVICE_UNAVAILABLE`) keeps the socket until a later sweep can decide. The allowed origins come from the validated `CORS_ORIGIN`, read after the Vault secrets are merged. The gateway emits nothing itself. Every producer, in any process, publishes through the realtime port (`REALTIME`, `infrastructure/realtime/`): `publishToTenant()`, `publishToRoles()` and `publishToUser()` are its only operations, so there is no broadcast to every socket. A push carrying data not every member may see (another user's details, the analytics live feed) goes to role rooms, never the tenant room. With `REALTIME_ADAPTER=redis` (default) publishers use the Socket.IO Redis emitter and each gateway attaches the Socket.IO Redis adapter on channel prefix `{app}:{env}:global:realtime:socket-io:v1`, so a worker reaches sockets held by public processes; `local` delivers only to sockets of the publishing process (single node).

API rules, versioning, error envelope and request signing: [api-conventions.md](api-conventions.md).

## Backend roles

The backend is one codebase with four entry points. Each role has its own root module, composed from shared building blocks, its own esbuild bundle (`dist/<role>/main.js`, `esbuild.config.mjs`) and its own image (`Dockerfile` target) and Deployment. Services are shared; what differs is which transport modules a root imports, so a module or feature is split into `<feature>.module.ts` (services, storage), `<feature>-api.module.ts` (controllers, RPC controllers), `<feature>-internal.module.ts` (internal RPC) and `<feature>-worker.module.ts` (processors).

| Role        | Root (`src/roles/`)             | Inbound                                      | Runs                                                                                                                                           |
| ----------- | ------------------------------- | -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `public`    | `public/public.module.ts`       | HTTP 3100, public RPC 50051, Socket.io `/ws` | REST exceptions, public RPC services, the WebSocket gateway                                                                                    |
| `private`   | `private/private.module.ts`     | internal RPC 50061                           | internal-tier RPC services (`tropis.user.internal.v1`)                                                                                         |
| `worker`    | `worker/worker.module.ts`       | none                                         | message consumers (user, analytics, tracking, membership graph), the outbox relay, BullMQ job workers, the Temporal workers                    |
| `scheduler` | `scheduler/scheduler.module.ts` | none                                         | cron triggers only (`*.schedule.ts`); each enqueues a job the worker runs, with a per-tick job id so extra replicas enqueue nothing more       |
| `all`       | `src/app.module.ts`             | all of the above                             | every role in one process: `make dev`, the e2e suite; Bull Board at `/api/queues` outside production, answering only direct localhost requests |

Every root imports `roles/shared/core.module.ts`: validated config, observability, the tenant context, the in-process event bus, the metrics registry and the ops listener on `OPS_PORT` (9464): `/livez`, `/readyz`, `/metrics`. Nothing in it touches a datastore. Every other Nest module imports the capability modules it uses (`CacheModule.forRoot()`, `MessagingModule.forRoot()`, …; each `forRoot()` returns one shared instance), so a role connects only to what the modules it runs need: the scheduler opens Redis for its jobs only, and the private role reaches no Postgres, Temporal, search or OLAP store. A capability module imports the driver connection behind an adapter only when its selector names that adapter, read after the Vault secrets are merged (`importWhenSelected`, `infrastructure/capability/conditional-import.ts`): Redis when a redis adapter is selected, Pulsar with `MESSAGING_ADAPTER=pulsar`, Aerospike with `KV_ADAPTER=aerospike`, the Postgres pool with `VECTOR_ADAPTER=pgvector` where the vector capability is imported.

Rules and reasons:

- One role per process, so each scales on its own signal (requests for public, backlog for worker) and a crash or deploy of one does not take the others down.
- The worker has no inbound API and the public role no background work, so scaling the API never multiplies consumers or cron ticks. dependency-cruiser enforces what each root may reach ([project-structure.md](project-structure.md)).
- The scheduler only enqueues: business work that runs inside a cron would run on whichever replica fired it, unretried and unobserved; a job gets retries, the dead-letter queue and a worker's trace. The outbox relay is not a cron: it is a worker loop, because every worker polls with per-aggregate leases.
- Readiness fails only on a dependency the role cannot serve without, so an outage of a store only some requests touch does not take it out of rotation (the down optional dependencies are listed in `degraded`); liveness checks nothing external, so a dependency outage never restarts pods.

## Backend request lifecycle

### Bootstrap order (`src/roles/<role>/main.ts`)

```
import './role'                    sets SERVICE_ROLE, the role label on every log record and span
import '../../env-bootstrap'       load .env from the working directory before decorators read process.env
import '../../tracing'             start OpenTelemetry before any instrumented module loads
bootstrapRole(<Role>Module, …)     roles/shared/bootstrap.ts
  ├─ OpsServer.listen(9464)        first, with no probes: /livez answers, /readyz is 503 {status:'starting'}
  ├─ validatedConfigModule         roles/shared/validated-config.ts: Vault KV into process.env, then ConfigModule validates env with Joi
  ├─ create                        NestFactory.create (public, all) or createApplicationContext (private, worker, scheduler)
  ├─ installShutdown               SIGTERM/SIGINT run shutdownRole (below)
  ├─ httpSurface (public, all)     roles/shared/http.surface.ts:
  │    trust proxy 1               client address = right-most X-Forwarded-For hop; X-Real-IP ignored
  │    helmet()                    security headers
  │    json/urlencoded 1mb         body cap; raw bytes kept on req.rawBody for SignatureGuard
  │    enableCors(allowlist)       config/cors.constants.ts; the same list guards the public RPC listener
  │    ValidationPipe              whitelist + forbidNonWhitelisted + transform
  │    setGlobalPrefix('api')
  │    Swagger at /api/docs        only when NODE_ENV !== 'production'
  │    listen(3100)
  ├─ rpcSurface                    roles/shared/rpc.surface.ts: :50051 public (public, all), :50061 internal (private, all)
  └─ OpsServer.attach(probes)      boot done: /readyz reports the role's probes
```

The ops port opens before anything else boots, so liveness answers while the modules connect, and the orchestrator does not route to a role whose boot has not finished.

Shutdown (`shutdownRole` in `roles/shared/bootstrap.ts`), in dependency order, so no request or message is cut off while a connection it needs is still open:

1. `OpsServer.drain()`: `/readyz` answers 503, so the orchestrator stops routing to the pod.
2. Every surface stops accepting and drains its in-flight calls (RPC listeners, the HTTP server), bounded by `DRAIN_TIMEOUT_MS` (10 s).
3. `app.close()`: `onModuleDestroy` stops consumers, job workers and the outbox relay, which finish their in-flight work; then `onApplicationShutdown` releases each connection (Mongo, Redis, Pulsar) and closes the ops port.

The HTTP server's stop also destroys the sockets upgraded off it (the WebSocket connections), because an upgraded socket never ends on its own and would hold the drain open. The whole shutdown has a hard deadline, `SHUTDOWN_TIMEOUT_MS` (default 55 s for the worker, 20 s for the other roles, inside the pods' 60 s and 30 s termination grace periods): a close that never settles ends in a logged exit with code 1 instead of a `SIGKILL`.

`JWT_SECRET` is required with a minimum of 32 characters; a missing or short value fails validation and the process exits at startup. Nest's global filters, interceptors and guards apply to HTTP only: `RpcServer` (`infrastructure/rpc/rpc-server.service.ts`) dispatches RPC calls itself through its own interceptor chain (`infrastructure/rpc/interceptors/`), outermost first: metrics, correlation (trace and correlation id), errors (thrown errors to Connect codes via `rpc-errors.ts`), authentication (verifies the bearer token once per call), tenant, audit.

HTTP enhancers registered in `PublicModule` (`roles/public/public.module.ts`): `ThrottlerBehindProxyGuard` (named throttlers `default` and `auth`, counted through the `ratelimit` port in Redis, so the limits hold across replicas), `JwtAuthGuard` (every HTTP route requires a JWT unless marked `@Public()`), `CorrelationIdMiddleware` and `TenantMiddleware` on all routes. `HttpTenantInterceptor` (`common/interceptors/http-tenant.interceptor.ts`) is the `APP_INTERCEPTOR` that binds `TenantContext` around every HTTP handler. `GlobalExceptionFilter` (one error shape, [api-conventions.md](api-conventions.md)) is the `APP_FILTER`, registered by `common/observability/observability.module.ts`.

### Request → response flow (User create)

```
RPC UserService/Create { name, email, password, idempotency_key? }
  ▼ UserRpcController.create()           @Audited('user.create')
  │   caller allowed user:create → UserService.create(dto)            (an admin adding a member)
  │   otherwise                  → UserService.signUp(dto, client address)   (self sign-up)
  │        SignupPolicyService: tenant registered, active and selfSignup on, else TENANT_SIGNUP_CLOSED;
  │        RATE_LIMITED per client address and per tenant
  ▼ CommandBus.execute(CreateUserCommand)
  ▼ CreateUserHandler.execute()
  │   ① DEDUP claim CREATE_REQUEST_DEDUP.forTenant(tenantId, requester, key)   requester user:<id> | ip:<address>
  │        ── already claimed and a stored response in KV → return it
  │   ② password floor (8) + per-tenant email uniqueness pre-check
  │   ③ DOCUMENTS.withTransaction(tx => …):
  │        UserRepository.create(…, tx)            → users
  │        UserEventStoreService.append(…, tx)     → user_event_store
  │        OutboxService.write(…, tx)              → outbox (status pending, topic user-events)
  │   ④ EventEmitter2.emit(UserCreatedEvent)
  │        └─ UserEventHandlers.onUserCreated()   → REALTIME.publishToRoles([admin], 'user.created', { userId, name })
  │   ⑤ KV SET CREATE_RESPONSE_KEY.forTenant(tenantId, requester, key) = response  (24 h, fire-and-forget)
  ▼ RPC response

Asynchronously:
  OutboxRelay (every 5 s) → Pulsar user-events, keyed by user id → UserProcessor (sub user-processor-sub, key_shared)
     EventConsumer.once(USER_EVENT_SEEN.global(<eventId>))   claim 30 s, extended to 24 h on success
     UserProjectionService.apply(): re-read the user from MongoDB; missing or soft-deleted → purge (search, pgvector, profile cache)
     runSinks on the current state (Promise.allSettled; any rejection except CapabilityDisabledError → nack):
     ├─ UserSearchService index sink           → SEARCH port, Elasticsearch index users
     ├─ UserSimilarityService.upsert()         → VECTOR port, pgvector (swallows its own errors)
     └─ NotificationService.enqueue()          → notification queue, welcome email (jobId welcome-<userId>)
     then OnboardingService.start(), only if WORKFLOW.isAvailable(), fire-and-forget (.catch → warn, never retried):
       WORKFLOW.start(tenantId, userOnboardingWorkflow, workflowId onboarding-<userId>)   queue user-onboarding, engine id t.<tenantId>:onboarding-<userId>
```

A unique-index race on email is reported as `USER_ALREADY_EXISTS`, not as a driver error. Roles are never taken from the create request; new users get the schema default (`member`).

### CQRS and event sourcing (user module)

The user module uses `@nestjs/cqrs`: commands (`commands/`) write and queries (`queries/`) read. The create, update, delete and role-change commands append to the event store and write an outbox row. An OAuth sign-up goes through the same create command (`UserService.signUpWithProvider`), so it emits `user.created` like any sign-up. `UpdateRolesCommand` (`UserService.updateRoles`) writes the roles, the event-store entry and a `user.updated` outbox event carrying `roles` and `status` in one transaction. Only the login counter writes `users` directly and emits no event.

Two rules hold inside those transactions:

- **Sessions end on a credential change.** A password, email, role or status change increments the user's `tokenVersion` in the same write, which ends every access and refresh token issued before it ([Authentication and authorization](#authentication-and-authorization)).
- **A tenant keeps an admin.** Demoting, deactivating or deleting an admin requires another active admin, checked inside the same transaction (`UserRepository.touchOtherAdmins` writes every other active admin, so two concurrent demotions conflict instead of both passing); otherwise the command fails with `USER_LAST_ADMIN`.

```
Write  UserService.create|update|delete|updateRoles ─► CommandBus ─► *Handler
          ├─ UserRepository               → MongoDB users (current state)
          ├─ UserEventStoreService.append  → user_event_store (history)
          └─ OutboxService.write          → outbox → Pulsar → UserProcessor

Read   UserService.findById ─► QueryBus ─► GetUserHandler
          ├─ cache GET USER_PROFILE_CACHE.forTenant(tenantId, id)  ── hit → return
          └─ miss → UserRepository.findById(tenantId, id) → cache SET (300 s, single-flight)
```

Event store documents have the shape `{ aggregateId, type, payload, version, schemaVersion, occurredAt }`. `UserEventStoreService.replay(aggregateId)` passes each payload through `migratePayload` (keyed on `schemaVersion`) and applies the events in order to rebuild a user's state; `getHistory(aggregateId)` returns them raw. Neither method has a caller outside the service.

### Cache-aside

`GetUserHandler` caches the profile under the tenant-scoped `USER_PROFILE_CACHE` key for 300 s. Authorization never reads it: the `TokenVerifier` reads the member's status, roles and token version from the store on every call (`UserRepository.findAccess`, uncached), so a role or status change applies to the next request on every process. `CachePort.getOrLoad()` is single-flight per key, and a cache read error falls through to the loader. The key is deleted synchronously by the update, delete and role-change paths, and again by `UserProjectionService` on `user.updated` / `user.deleted`, so a missed synchronous delete is corrected once the event is consumed. `AnalyticsService.getStats()` caches `ANALYTICS_STATS_CACHE.forTenant(tenantId)` for 30 s; `AnalyticsService.create()` deletes it.

## Event pipeline

| Stage          | Implementation                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Write + outbox | Services write the domain change and an outbox row (`infrastructure/outbox/outbox.schema.ts`: `aggregateId`, `topic`, `payload`, the event attributes `event { id, type, subject, tenantId, time, traceparent, tracestate, schemaVersion }`, `status`, `attempts`, `nextAttemptAt`) in one MongoDB transaction through `OutboxService.write({ topic, aggregateId, type, tenantId, data }, tx)` inside `DOCUMENTS.withTransaction()`                                                                                                                                                                                                                                                                                                                                      |
| Relay          | `outbox.relay.ts` publishes each row as a CloudEvent in binary mode through `MESSAGING` (`infrastructure/messaging/`): the row's event attributes become the `ce_*` properties (`ce_source` `/tropis/backend/outbox`), the stored `traceparent` is the parent of the publish span, and the body is the row's `payload` unchanged. Every message is keyed by its `aggregateId` (Pulsar partition and ordering key, Kafka record key). The adapter is chosen by the `MESSAGING_ADAPTER` env var                                                                                                                                                                                                                                                                            |
| Bus            | Pulsar by default. Topics are logical names (`user-events`); the Pulsar adapter maps them to `persistent://public/default/<topic>`, Kafka uses the name as is. Consumers start through `EventConsumer.start(spec)` (`infrastructure/messaging/event-consumer.ts`) over `MessagingPort.subscribe()`: handler resolves → ack, throws → redelivery after a delay that doubles per attempt (`MESSAGING_REDELIVERY_DELAY_MS` 1 s, capped at `MESSAGING_MAX_REDELIVERY_DELAY_MS` 30 s); after `MESSAGING_MAX_REDELIVERIES` (10) redeliveries → `<topic>-DLQ`, in every adapter ([Dead-letter handling](#dead-letter-handling)). An unacked message is redelivered after `MESSAGING_ACK_TIMEOUT_MS` (60 s). Payload evolution is add-only, so consumers tolerate unknown fields |
| Consumers      | `UserProcessor` (`user-events`, `key_shared`), `MembershipGraphProcessor` (`user-events`, own `key_shared` subscription, only with the graph enabled), `AnalyticsProcessor` (`analytics-events`, only with `STREAM_ENGINE=node`), `TrackingProcessor` (`tracking-events`), Flink (`analytics-events`, own subscription, only with `STREAM_ENGINE=flink`)                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Read model     | ClickHouse tables under `logs.*` (init SQL in `infra/clickhouse/`); `tenant_id` leads every `ORDER BY`. Inserts use `async_insert` with `wait_for_async_insert`, so the server merges the consumers' small per-event inserts into large parts while a failed write is still a rejected insert that gets redelivered                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Live push      | Consumers publish through `REALTIME` after the write. `AnalyticsSinkService`, `TrackingSinkService` and the onboarding follow-up activity catch a failed publish, so it never nacks or retries a write that already happened                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |

Every message is a CloudEvents 1.0 event (`EventEnvelope`, `packages/shared/src/events/envelope.ts`) in binary content mode: attributes travel as `ce_<attribute>` properties (Pulsar) or headers (Kafka), `traceparent`/`tracestate` under their own names, and the body is the data unchanged, so body-only readers such as the Flink job need no envelope code. The naming rule for `type` is `<domain>.<entity>.<past-tense-verb>` (`isConformingEventType()`; `analytics.event.recorded`, `tracking.batch.received`); the user events keep the two-segment names `user.created`, `user.updated`, `user.deleted`, listed in `LEGACY_EVENT_TYPES` (`events/event-types.ts`) as the only exceptions the envelope tests allow. `id` is stable across redeliveries. `source` is never empty: an envelope built or received without one carries `urn:tropis:unknown-source`. `datacontenttype` describes the data as sent: `application/json` for an object payload, `application/octet-stream` for raw bytes. `schemaversion` versions the data schema of a `type`; `dataschema`, when set, is that schema's URI. The envelope is built only from the attributes the publisher sets (`createEventEnvelope()`), never from fields of the data. `EventConsumer.start()` hands a handler the data decoded from the JSON body, the envelope (id, type, subject, tenant) and the envelope's tenant, runs it inside that tenant, and drops (acks) an event whose data names another `tenantId`; a message without a tenant fails with `TENANT_REQUIRED` and is redelivered, then dead-lettered. `start()` subscribes in the background: a failed subscribe is retried with backoff (1 s doubling to 30 s), and a subscription that stops on its own is subscribed again the same way. The `consumers` probe is down while any started consumer is not subscribed, and the worker role requires it ([Observability](#observability)). Event types and the user events contract (topic, data types) live in `@tropis/shared` (`events/event-types.ts`, `events/user-events.ts`), so a consumer outside the user module depends on the contract, not on the module. `UserProcessor` dedups on the envelope id; `AnalyticsProcessor` dedups on the domain `eventId` in the data, which is also its envelope id (the analytics envelope type is `analytics.event.recorded`; the analytics event type is `data.eventType`).

Exactly one engine writes `logs.analytics_events`, chosen by `STREAM_ENGINE` ([tech-decisions.md](tech-decisions.md#stream-processing-flink)).

### Tracking (user-behavior instrumentation)

```
SDK tracker (packages/sdk/src/tracking/) ──sendBeacon / fetch keepalive──►
  POST /api/v1/track          (@Public, 202, throttle 600/min)
  POST /api/v1/track/secure   (@Public + @RequireSignature: API key + HMAC)
    ──► TrackingService.ingest()
          DEDUP claim TRACKING_EVENT_SEEN.forTenant(tenantId, eventId), 24 h, per event
            (duplicates counted in tropis_tracking_duplicate_events_dropped_total)
          ──direct publish──► Pulsar tracking-events
                                 ──► TrackingProcessor ──► ClickHouse logs.user_behavior
                                                       └─► REALTIME 'tracking.event'
helm /behavior ◄── gRPC TrackingService.GetInsights (JWT + OPA)
```

Tracking takes REST ingest and publishes directly, without the outbox; the reasons are in [tech-decisions.md](tech-decisions.md#tracking-user-behavior-instrumentation). A failed publish drops the batch after the 202. If the dedup store is unavailable, dedup is skipped and the batch is accepted. `TrackingProcessor` dedups again on write ([Idempotent consumers](#idempotent-consumers-replay-safe-side-effects)), so a redelivered batch is not inserted into `logs.user_behavior` twice. Feature: `features/tracking/`; proto: `proto/tracking/v1/tracking.proto`; table: `infra/clickhouse/init-tracking.sql`; event naming rules: [tracking-plan.md](tracking-plan.md).

### Other asynchronous work

| Mechanism | Use                                                                                                                                                                                                                                                                                                                       | Location                       |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| BullMQ    | Short retryable jobs behind the `JOBS` port: `notification`, `outbox-maintenance`, `dead-letter`                                                                                                                                                                                                                          | `src/infrastructure/jobs/`     |
| Temporal  | Long-running durable workflows behind the `WORKFLOW` port (`userOnboardingWorkflow`); the client reconnects on demand (at most once per 10 s) when Temporal is unreachable; each worker retries its start with backoff (5 s doubling to 60 s) without blocking boot, and is started again the same way when its run fails | `src/infrastructure/workflow/` |
| `@Cron`   | Scheduler role only, in `*.schedule.ts` files: each tick enqueues a BullMQ job a worker runs (outbox sweep, 1 min)                                                                                                                                                                                                        | `outbox-sweep.schedule.ts`     |

When to choose which: [tech-decisions.md](tech-decisions.md).

## Multi-tenancy

Every user belongs to exactly one tenant. Tenants share collections and tables; isolation is enforced by each store's adapter or by the database, not by callers remembering a filter. There is no default tenant: work that cannot name its tenant is rejected with `TENANT_REQUIRED`, and platform-wide work opts out explicitly.

### Resolving the tenant

`resolveTenant()` (`common/tenant/tenant-resolution.ts`) is the one rule, used by HTTP (`TenantMiddleware` + `HttpTenantInterceptor`) and RPC (`infrastructure/rpc/interceptors/tenant.interceptor.ts`):

```
1. A verified access token (TokenVerifier)      → its tenantId is authoritative
2. X-Tenant-ID header (or ?tenant= on HTTP)     → only without a verified token;
                                                  with one it must name the token's tenant, else 403 TENANT_MISMATCH
3. neither                                      → no tenant; any tenant-scoped read fails with 400 TENANT_REQUIRED
A malformed hint                                → 400 TENANT_INVALID
```

The token wins because it is the only tenant claim the server itself signed; a header on an authenticated call can only confirm it, so a user cannot hop tenants. The header exists for calls that carry no token yet: login, sign-up, the internal tier and anonymous tracking. `?tenant=` exists only because `navigator.sendBeacon` cannot set headers. Consumed messages take the tenant from the event envelope (`tenantid`); `consumeEnveloped` (`infrastructure/messaging/messaging.envelope.ts`) runs the handler inside it, and a handler whose payload names a different tenant drops the event. Background jobs carry the enqueuer's scope in the job data under `__tenant` (`infrastructure/jobs/job-tenant.ts`): `JobsPort.enqueue()` outside a tenant or `runGlobal()` scope rejects with `TENANT_REQUIRED` before anything is queued, and every attempt runs inside `runInTenant()` / `runGlobal()` again, so a handler reads the tenant exactly as a request does; an attempt whose data carries no scope fails. A request signed with an API key runs in the tenant the key is bound to (`API_KEYS`), and a tenant hint naming another tenant is rejected with `TENANT_MISMATCH`. OAuth sign-ins, whose provider redirect carries no tenant, land in `OAUTH_TENANT_ID`.

`TenantContext` (`common/tenant/tenant.context.ts`) holds the scope in `AsyncLocalStorage`, so singletons read it without request-scoped DI. Scopes are typed: `runInTenant(tenantId)` or `runGlobal()`. `tenant` / `requireTenant()` throw `TENANT_REQUIRED` outside a tenant scope, including inside a global one, so global code cannot reach tenant data by accident. Global keys use `.global()`, global OLAP access `queryGlobal()` / `insertGlobal()`.

### Tenant directory

A tenant exists only once it is registered. The `TenantDirectory` port (`common/tenant/tenant-directory.port.ts`, token `TENANT_DIRECTORY`) is implemented in `modules/tenant/` over the MongoDB `tenants` collection (`{ _id, name, status: active | suspended, selfSignup }`) and wired into every role by `CoreModule`. Lookups are cached for 60 s (`TENANT_RECORD_CACHE`), so a suspension reaches every process within a minute.

| Operation                                                                                       | Rule                                                                                                                                                                                         |
| ----------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Self sign-up (`UserService/Create` without a caller allowed `user:create`, first OAuth sign-in) | Tenant registered, active and `selfSignup` on, else `TENANT_SIGNUP_CLOSED` for all three; counted per client address and per tenant ([development.md](development.md#environment-variables)) |
| Admin adds a member                                                                             | Caller allowed `user:create`; the self sign-up policy does not apply                                                                                                                         |
| Login (REST, RPC)                                                                               | Tenant registered and active, else `AUTH_INVALID_CREDENTIALS`, the same answer as a wrong password                                                                                           |
| Refresh, OAuth code exchange                                                                    | Tenant registered (`TENANT_NOT_FOUND`) and active (`TENANT_INACTIVE`)                                                                                                                        |
| Every verified token                                                                            | `TokenVerifier` rejects a token of an unregistered (`AUTH_TOKEN_INVALID`) or suspended (`TENANT_INACTIVE`) tenant                                                                            |

Why: without a registry any string in `X-Tenant-ID` would become a tenant on first sign-up, and a tenant could not be closed to sign-ups or switched off. Registering and suspending: `make tenant-create` ([development.md](development.md#adding-a-tenant)).

### Store fences

| Store                     | Fence                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Documents (MongoDB)       | Repositories extend `TenantScopedRepository` (`infrastructure/documents/tenant-scope.ts`), whose methods take the `TenantId` first and add it to every filter and insert. `tenantScopePlugin` on each tenant schema (users, user event store, event logs) rejects any query, update or aggregation without a valid `tenantId`, any update that changes it, and any insert without one; only `runGlobal()` passes (index sync)                             |
| Relational (Postgres)     | Tables with tenant rows have `tenant_id` under row-level security (`tenant_isolation` policy on `current_setting('app.tenant_id')`, forced for the owner). `RelationalPort.withTenant()` runs one transaction that sets `app.tenant_id` transaction-locally and switches to the non-owner role `tropis_tenant_scope`, so the policy applies even to a superuser connection. The tables and policies come from the migrations (`apps/backend/migrations/`) |
| Vector (pgvector)         | Every statement runs in `withTenant()` on the RLS table `vector_embeddings`, and `(tenant_id, collection, id)` is the primary key                                                                                                                                                                                                                                                                                                                         |
| OLAP (ClickHouse)         | `tenant_id` leads every tenant table's sort key; `insert(tenantId, …)` stamps `tenant_id` on each row (a row naming another tenant is rejected) after checking once per table that the sort key leads with `tenant_id`; `query(tenantId, …)` binds `{tenant_id:String}` and rejects SQL without a `tenant_id = {tenant_id:String}` predicate                                                                                                              |
| Search (Elasticsearch)    | The port owns the `tenantId` field: it is mapped as `keyword` on every index (a dynamic template forces it), set on every document (document id `<tenantId>:<id>`), and every query carries a tenant term filter. Before the first write to an index the port ensures it exists, and it refuses writes to an index whose `tenantId` is not `keyword`, because a term filter on an analyzed field would not isolate tenants                                |
| Graph (Neo4j)             | Every query must reference `$tenantId`, which the port binds; nodes and relationships written by the port carry it; a result that contains a node or relationship of another tenant is rejected                                                                                                                                                                                                                                                           |
| Cache / kv / lock / dedup | Keys come from `defineKey()` builders: `.forTenant(tenantId, …)` or the explicitly named `.global(…)`                                                                                                                                                                                                                                                                                                                                                     |
| Realtime (WebSocket)      | A socket joins only `t.<tenantId>`, `t.<tenantId>:user:<userId>` and `t.<tenantId>:role:<role>`; the realtime port publishes only to rooms of one tenant (`publishToTenant`, `publishToRoles`, `publishToUser`) and has no broadcast                                                                                                                                                                                                                      |
| Objects (MinIO)           | Every method takes the `TenantId` and stores the key under `t.<tenantId>/`; keys with `..` or empty segments and absolute keys are rejected. The avatar endpoints also check that the target user is a member of the caller's tenant                                                                                                                                                                                                                      |
| Workflow (Temporal)       | Every method takes the `TenantId`; the engine id is `t.<tenantId>:<id>` and every visibility query filters `WorkflowId STARTS_WITH 't.<tenantId>:'`                                                                                                                                                                                                                                                                                                       |
| Audit (`logs.audit_log`)  | Entries carry the resolved tenant; an action that resolved none (an anonymous request without a hint) is written as a platform-scope row with `tenant_id` `''`                                                                                                                                                                                                                                                                                            |

Each store's conformance suite proves that tenant A never reads or changes tenant B's data (`src/infrastructure/*/__tests__/*.conformance.ts`, run against real stores by `test/integration/`; Postgres RLS in `relational.conformance.spec.ts`, the Mongo fence in `repository.integration.spec.ts`).

Lexical rules (OLAP predicate, graph `$tenantId`) cannot prove that a hand-written query filters every pattern; review hand-written SQL and Cypher against them.

Tenant provisioning steps: [development.md](development.md#adding-a-tenant).

## Reliability patterns

### Outbox (atomic event delivery)

Without an outbox, a crash between the MongoDB commit and the Pulsar publish leaves a committed change with no event, and Elasticsearch, pgvector, email and ClickHouse never learn of it.

```
Service transaction (DOCUMENTS.withTransaction)
  ├─ domain write(s)
  └─ OutboxService.write()  → outbox_heads upsert { _id: aggregateId, dueAt, v++ }
                              + outbox row, status pending, event attributes fixed   (commit or roll back together)

OutboxRelay.relay()   loop in every worker: 5 s after the previous poll ends, 10 ms after a poll that relayed a full batch
                      (a poll never overlaps the previous one; the first poll of a process runs repairHeads())
  └─ dueAggregates(200)  candidates from outbox_heads by the dueAt index: aggregates whose head row is pending,
                         or failed with nextAttemptAt ≤ now or unset
       relay up to 50 of them (random order when there are more), skipping aggregates another instance holds
       for each aggregate:
         LOCK.acquire(OUTBOX_AGGREGATE_LEASE.global(aggregateId), 45 s)  ── held → another instance has it, next
                                                                      ── lock store down → log, stop the poll
           up to 20 times:  headOf(aggregate), read fresh    ── none / dead / failed and not due → done
             renew lease     ── lost → stop, rows stay open
             broker.publish(topic, payload, { event, key: aggregateId })  in the stored trace context,
                             timeout 30 s, lease renewed every 5 s while in flight
                             → tropis_outbox_published_total++ → markDispatched (expireAt = now + retention)
                               mark fails → warn, the row stays open and is published again (not a failed attempt)
             messaging disabled → rows stay pending, attempts untouched, stop the poll
             on error  → markFailed (only if the row is still pending or failed): attempts++;
                         attempt 5 → dead, else failed with nextAttemptAt = now + 5 s × 2^(attempts-1);
                         tropis_outbox_publish_failed_total{result=failed|dead}++; stop this aggregate
           settleHead(aggregate)   retire the head when no row is open and v is unchanged, else set its dueAt
         release lease
  └─ heartbeat gauge tropis_outbox_relay_last_poll_timestamp_seconds  (only after a completed poll)

OutboxRelay.sweep()  job outbox-sweep on queue outbox-maintenance, enqueued by the scheduler once a minute
                     (job id per minute, so it runs once per minute cluster-wide), run by one worker
  ├─ deadLetterExhausted(5)  failed rows with attempts ≥ 5 → dead
  ├─ repairHeads()           a head for every aggregate with a pending or failed row; re-derive heads that are not due
  ├─ newly dead or DEAD backlog > 0 → error log, event outbox.dead-backlog
  └─ backlogByStatus()       → gauge tropis_outbox_backlog_rows{status}
Every worker also refreshes tropis_outbox_backlog_rows once a minute from its relay loop, so each instance's series stays current.
```

| Status       | Meaning                                                                                                       |
| ------------ | ------------------------------------------------------------------------------------------------------------- |
| `pending`    | Waiting to be published                                                                                       |
| `dispatched` | Published; deleted by a MongoDB TTL index on `expireAt` after `OUTBOX_RETENTION_DAYS` (7)                     |
| `failed`     | Publish error; due again at `nextAttemptAt` (a `failed` row without `nextAttemptAt` is due now)               |
| `dead`       | Five attempts exhausted; blocks its aggregate until an operator redrives or skips it, so the loss is explicit |
| `skipped`    | An operator gave the event up; never published; deleted after `OUTBOX_RETENTION_DAYS` like `dispatched`       |

Rules and reasons:

- The publish is decoupled from the business transaction, so a Pulsar outage does not fail the write. It does not make delivery unbounded: each row gets five attempts (backoff 5 s × 2^(n-1)), so an outage longer than about 75 s (5 + 10 + 20 + 40 s of backoff) moves every attempted row to `dead`.
- Order is per aggregate: an aggregate's rows leave in insertion order (`createdAt`, then `_id`), and none of them leaves while an earlier one is `failed` and not yet due, or `dead`. Publishing a later event past an earlier one would apply them out of order (a `user.updated` after a lost `user.deleted` resurrects the user in search).
- Leases are per aggregate, not global, so any number of relay instances run at once and aggregates are relayed in parallel. The head row is re-read after the lease is taken, so a row another instance just published is not published again. The lease (45 s) outlasts the publish timeout (30 s) and is renewed before every publish and every 5 s while one is in flight, so a slow publish does not hand the aggregate to another instance; if the lease is lost anyway, a second instance can publish the same row once more, which consumers already dedup. Reading 200 candidates for 50 slots, in random order, spreads concurrent instances over the backlog instead of having them contend for the same oldest aggregates. Keying each message by its aggregate lets `key_shared` subscribers compete for the topic while one aggregate's events still reach one consumer in order.
- Candidates come from `outbox_heads`, one document per aggregate with open rows, written in the same transaction as the row: a poll reads an index range on `dueAt` and never scans or sorts the row backlog, so its cost does not grow with the backlog. `v` changes on every write, so the relay retires a head only when no row was written since it looked; `repairHeads()` (first poll of each process, and the sweep) recreates a head lost to a crash and re-derives one whose rows were changed by hand.
- Terminal rows (`dispatched`, `skipped`) expire through a TTL index, so the collection holds the open backlog plus `OUTBOX_RETENTION_DAYS` of history instead of growing without bound. Open rows have no `expireAt` and are never deleted.
- With `MESSAGING_ADAPTER=disabled` nothing can be published: rows stay `pending` with their attempts untouched, so switching messaging on later delivers them instead of finding them dead.
- The event id, time, tenant and trace context are fixed when the row is written, so every attempt of one event carries the same id (consumers dedup on it) and the trace continues from the request that caused it.
- A DEAD row blocks its aggregate on purpose, and releasing it is an explicit operator decision, not a timeout: `OutboxService.redrive({ id } | { aggregateId })` puts DEAD rows back to `pending` with a fresh attempt budget (use it once the cause is fixed); `OutboxService.skip({ id } | { aggregateId })` moves them to `skipped` so the aggregate's later events flow (use it when the event must be given up; consumers see a gap). Both touch only `dead` rows. From a shell: `make outbox-dead` lists them, `make outbox-redrive ID=<row id> | AGGREGATE=<id>` and `make outbox-skip ID=<row id> | AGGREGATE=<id>` apply the same transitions (`devtools/src/outbox-dead.ts`).
- A lock-store outage while acquiring a lease is logged as an error (event `outbox.relay-lock-unavailable`) and stops the poll, because otherwise it is indistinguishable from "another instance holds the lease"; the heartbeat then goes stale and `OutboxRelayStalled` fires.

Inspect the backlog with `make outbox-status`. Alerts: `OutboxDeadRows`, `OutboxFailedBacklogSustained`, `OutboxPendingBacklogGrowing`, `OutboxRelayStalled` (`infra/prometheus/alerts.yml`).

### Idempotent requests

Network retries can deliver the same create twice. `CreateUserHandler` accepts an optional `idempotency_key` (gRPC) / `idempotencyKey` (DTO):

1. Before any work, claim `CREATE_REQUEST_DEDUP.forTenant(tenantId, requester, key)`; when it is already claimed, the stored response under `CREATE_RESPONSE_KEY` is returned with no writes and no events.
2. On a first request, execute normally, then store the response with a 24 h TTL. The store is fire-and-forget: a kv failure does not fail the request.

The key is scoped to the caller (`user:<id>` for an authenticated caller, `ip:<address>` for an anonymous one), so one caller cannot read another caller's response by reusing its key.

### Idempotent consumers (replay-safe side effects)

At-least-once delivery, ack timeouts and outbox lease expiry can deliver one event more than once. Each consumer claims the event id through `EventConsumer` (`infrastructure/messaging/event-consumer.ts`), which owns the claim, its TTL and its release for every consumer:

```
EventConsumer.once(<MODULE>_EVENT_SEEN.global(eventId), work)     (onceEach for a batch: one key per item)
  DEDUP.claim(key, CONSUMER_CLAIM_TTL_SECONDS = 30 s)
  → false   duplicate → skip
  → true    run the work
              success → DEDUP.extend(key, 24 h)   (commit the dedup window; a failed extend only warns)
              failure → DEDUP.release(key), rethrow   (the redelivery may retry)
```

| Consumer                   | Claim                                                                                                                                                                                                                                                                                            |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `UserProcessor`            | `USER_EVENT_SEEN` on the envelope id                                                                                                                                                                                                                                                             |
| `MembershipGraphProcessor` | `MEMBERSHIP_GRAPH_EVENT_SEEN` on the envelope id                                                                                                                                                                                                                                                 |
| `AnalyticsProcessor`       | `ANALYTICS_EVENT_SEEN` on the domain `eventId`. A failed ClickHouse insert throws (`SERVICE_UNAVAILABLE`), so the claim is released and the message nacked for redelivery                                                                                                                        |
| `TrackingProcessor`        | `TRACKING_EVENT_WRITTEN.forTenant(tenantId, eventId)` per event of the batch: 30 s while the insert runs, extended to 24 h after it; released and rethrown when the insert fails. Separate from the ingest claim `TRACKING_EVENT_SEEN`, which `TrackingService.ingest()` takes before publishing |

The claim is short (30 s) and below the 60 s ack timeout (`MESSAGING_ACK_TIMEOUT_MS`; the module refuses to load otherwise), so a pod killed mid-handler cannot leave a marker that makes the redelivery look like a duplicate. `UserProjectionService.runSinks()` runs the Elasticsearch, pgvector and welcome-email sinks with `Promise.allSettled` and throws if any rejected, so the message is nacked instead of acked with a sink missing; each sink is therefore idempotent (the welcome email uses the deterministic BullMQ `jobId` `welcome-<userId>`). Two paths sit outside that retry: the pgvector upsert and delete swallow their own errors, so a pgvector failure never nacks; and the onboarding workflow start (`workflowId` `onboarding-<userId>`, engine id `t.<tenantId>:onboarding-<userId>`) runs after the sinks, only when `WORKFLOW.isAvailable()`, fire-and-forget with `.catch(warn)`, so a failed start is logged and never retried.

### Circuit breaker

A slow or down OPA would otherwise block every authorized call until timeout and cascade under load. `CircuitBreaker` (`common/circuit-breaker/circuit-breaker.ts`, dependency-free) wraps every OPA call: the `PolicyPort` (`POLICY`, `infrastructure/policy/`) adapter `adapters/opa/opa-policy.adapter.ts` fires each `allow()` through it:

```
CLOSED     calls pass; consecutive failures counted
OPEN       after 5 failures: calls rejected immediately (CircuitBreakerOpenError) for 30 s
HALF_OPEN  exactly one probe call passes, concurrent calls are rejected until it settles;
           a success → CLOSED, a failure → OPEN
```

Each OPA request has a 2 s abort timeout and, when `OPA_TOKEN` is set, carries it as a bearer token, for an OPA run with `--authentication=token` ([security-checklist.md](security-checklist.md)). An OPA that cannot answer (a non-2xx response, a timeout, a network error or an open circuit) is `SERVICE_UNAVAILABLE`, never a denial: an outage stays retryable and is not reported to a caller as a missing permission, and no request is allowed without a decision. Every failed call, a non-2xx answer included, counts toward opening the circuit. Only an answered `result: false` is `FORBIDDEN`.

### Dead-letter handling

| Layer     | Mechanism                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Messaging | After `MESSAGING_MAX_REDELIVERIES` (10) redeliveries, backing off from 1 s to 30 s, a message goes to `<topic>-DLQ`, so a poison message is parked instead of redelivered forever. The subscription `<subscription>-DLQ` exists from the first subscribe and keeps every dead-lettered message until an operator acts: `make messaging-dlq TOPIC=<topic> SUB=<subscription>` lists them, `make messaging-dlq-redrive TOPIC=<topic> SUB=<subscription> [COUNT=n]` publishes the oldest back to `<topic>` with their properties and key and drops them from the DLQ (`devtools/src/messaging-dlq.ts`, Pulsar only; consumers dedup on the event id, so a redrive of an event that was handled changes nothing). Kafka publishes to the same `<topic>-DLQ` and pins the group `<subscription>-DLQ` to it; it is visible through the consumer metrics and alerts. Prometheus scrapes the broker (`pulsar:8080`); alerts `ConsumerDeadLettering`, `ConsumerFailureRateHigh`, `PulsarDeadLetterBacklog`, `PulsarDeadLetterRateHigh` |
| BullMQ    | Each queue is declared by the module that owns it with `JobsModule.forFeature()`: `notification` (`NOTIFICATION_QUEUE`, `modules/notification/`) gets 3 attempts with exponential backoff (2 s base); `outbox-maintenance` (`OUTBOX_MAINTENANCE_QUEUE`, `infrastructure/outbox/`) 1 attempt; `dead-letter` belongs to the jobs capability. A queue declared with `deadLetter: true` (only `notification`) has each job that exhausts its attempts copied to `dead-letter` as `{ ...data, __sourceQueue, __sourceJobId, __sourceOpts, __failReason }` by `BullmqWorkersService`                                                                                                                                                                                                                                                                                                                                                                                                                                                |

A job or Temporal activity that fails with a 4xx `AppError` other than a timeout or rate limit (`isPermanentFailure`, `infrastructure/capability/permanent-failure.ts`) fails at once without its remaining attempts, because retrying the same input cannot succeed: BullMQ gets an `UnrecoverableError` (and a `deadLetter: true` queue dead-letters the job), Temporal a non-retryable `ApplicationFailure`. The mail port is one source: every adapter rejects a `to` that is not exactly one bare address with `VALIDATION_FAILED`, so no caller can turn a message into a relay, and an SMTP send that fails otherwise throws and is retried. An exhausted job of any other queue stays in that queue's failed set. `DeadLetterJob` (`infrastructure/jobs/dead-letter.job.ts`, a `@JobHandler` of `dead-letter`) logs every dead-lettered job. An operator replays one with `make jobs-dlq-replay ID=<id>` (`devtools/src/jobs-dlq.ts`; `make jobs-dlq` lists them): it retries the failed source job with a fresh attempt budget, or re-enqueues it on its source queue with the recorded attempts and backoff when BullMQ no longer holds it, then removes the dead-letter entry. Bull Board (`/api/queues`, `all` role outside production, direct localhost requests only) shows every queue the process declares.

### Graceful degradation

Capability adapters log a warning and keep the app running when their backing service is unavailable, and a capability configured `disabled` throws `CapabilityDisabledError` on every call, except the cache, whose disabled adapter is a pass-through (`getOrLoad` runs the loader); the per-dependency behavior is the "Degradation behavior" table in [tech-decisions.md](tech-decisions.md#degradation-behavior).

## Domain events (EventEmitter2)

`@nestjs/event-emitter` decouples command handlers from the side effects they trigger. It carries only ephemeral effects; durable effects go through the outbox (see [Architectural rules](#architectural-rules)).

```
CreateUserHandler ─emit─► UserCreatedEvent ─► UserEventHandlers.onUserCreated()
                                                 └─ REALTIME.publishToRoles(tenantId, [admin], 'user.created', { userId, name })
UpdateUserHandler ─emit─► UserUpdatedEvent ─► UserEventHandlers.onUserUpdated()
                                                 └─ REALTIME.publishToUser(tenantId, userId, 'user.updated')
```

In-process handlers fire immediately, without outbox-relay lag, and losing one is not a consistency bug.

## Authentication and authorization

| Concern          | Mechanism                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Password login   | `AuthService` (`modules/auth/`) requires the request's tenant to be registered and active, answering `AUTH_INVALID_CREDENTIALS` otherwise, so an anonymous caller cannot tell which tenant ids exist ([Tenant directory](#tenant-directory)); then checks lockout, the bcrypt hash and the account status in that tenant, and issues a JWT carrying `sub`, `email`, `roles`, `tenantId`, `jti` and `tv` (the user's `tokenVersion`). The `roles` claim is for display only (helm shows or hides UI with it); authorization never reads it. Access token lifetime `JWT_EXPIRES_IN` (default `15m`). The REST login returns `{ accessToken }` and sets the refresh token as a cookie                                                                                                                                                                                                                                                                                                                                |
| Refresh          | The refresh token lives only in the `tropis_rt` cookie (`modules/auth/cookies/refresh-cookie.ts`: HttpOnly, SameSite=Strict, `Path=/api/auth`, 7 days, `Secure` unless `NODE_ENV` is development or test, `COOKIE_SECURE` overrides), so page script never holds it; the console keeps the access token in memory. `POST /api/auth/refresh` takes no body, is CSRF-checked (below) and returns `{ accessToken }` with a rotated cookie; any failure clears the cookie. Stored as `REFRESH_TOKEN_KEY.forTenant(tenantId, userId, sha256(tokenId))` in kv with the `tv` it was issued under, rotated atomically on every refresh (`del` reports whether it existed, so two concurrent refreshes cannot both win); the refresh runs in the token's own tenant and refuses a token whose `tv` no longer matches (`AUTH_TOKEN_REVOKED`) and an account or tenant that is no longer active, so a suspension or a credential change also ends the refresh chain                                                          |
| Logout           | `POST /api/auth/logout` (public, CSRF-checked, 204): the access token's `jti`, when a valid one is sent, is revoked in kv (`TOKEN_REVOKED_KEY`) for its remaining lifetime, the refresh token named by the cookie is deleted with its session record, and the cookie is cleared                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| CSRF             | The cookie endpoints (refresh, logout) pass `CookieCsrfGuard` (`modules/auth/guards/cookie-csrf.guard.ts`): the request must carry `X-Tropis-Client: 1`, which a cross-site form or image cannot send and a cross-origin script cannot send without a CORS preflight, and come from an allowed origin (an `Origin` in the CORS allow-list, or no `Origin` with `Sec-Fetch-Site` `same-origin`/`same-site`); anything else is `AUTH_CSRF_REJECTED`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Token check      | One `TokenVerifier` (port and `TOKEN_VERIFIER` token in `common/auth/token-verifier.port.ts`, implementation `modules/auth/services/token-verifier.service.ts`) for REST (`JwtAuthGuard`), RPC (`RpcAuthzService`) and the WebSocket handshake: HS256 signature and expiry, required `sub`/`tenantId`/`jti`, revocation, the suspension marker, a live member record of the token's tenant with status `active` whose `tokenVersion` equals the token's `tv` (0 when absent), and a registered, active tenant. The member record is read from the store on every call (`UserRepository.findAccess`, never cached), and the principal's roles come from it, never from the token, so a role or status change applies to the next request. A password, email, role or status change increments `tokenVersion`, which ends every access and refresh token issued before it. A store it needs being down fails closed (`SERVICE_UNAVAILABLE`), because failing open would admit revoked tokens and suspended accounts |
| Lockout          | `login-lockout.service.ts`: 5 failures per email+IP and 30 per email across all IPs within 15 minutes (`ratelimit` counters, `kv` lockout markers, failing open), on both the REST and the RPC login                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| RPC login        | `AuthService/Login` (`auth.rpc.controller.ts`) runs the same credential check as the REST login (lockout, password, account status, session record) and returns an access token only. On top it applies a per-tenant, per-email attempt limit (`RPC_LOGIN_RATE_LIMIT`, 10 attempts per 60 s, then `RATE_LIMITED`, Connect `resource_exhausted`) that counts every attempt, not only failures, and fails open when the rate-limit store is unavailable. The HTTP throttlers do not cover it because they only see HTTP requests                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Sessions         | A session record per login in the `kv` port (`SESSION_KEY`, 7 days, `modules/auth/services/session.service.ts`), written on login and refresh and removed on logout; request authentication does not read it                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Authorization    | `@Authorize(resource, action)` (`common/authz/`) on a handler: `AuthorizeGuard` enforces it on HTTP routes (an `APP_GUARD` after `JwtAuthGuard`), the RPC authorization interceptor on RPC methods; both ask the `POLICY` port (OPA, `POST /v1/data/authz/allow`) with the caller's roles and deny with `FORBIDDEN`. The resource is a string the owning module chooses (`user`, `analytics`). A handler that branches on a permission instead of requiring it (`UserService/Create`) uses `AuthorizationService.allows()`. On RPC the authentication interceptor verifies the bearer token once per call and handlers read the caller with `RpcAuthzService.caller()`                                                                                                                                                                                                                                                                                                                                            |
| Policy           | `infra/opa/authz.rego`: `role_permissions[role][resource]` → allowed actions; `default allow := false`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Server-to-server | API key + HMAC signature (`SignatureGuard`, `@RequireSignature()`), keys from `API_KEYS`, each bound to one tenant, in which the signed request runs; see [api-conventions.md](api-conventions.md)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Audit            | `@Audited()` + `AuditInterceptor` write sensitive actions to ClickHouse `logs.audit_log` via `common/audit/` (schema `infra/clickhouse/init-audit.sql`, 2-year TTL)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Fences           | Helmet, CORS allowlist, 1 MB body cap, global `ValidationPipe`, global `JwtAuthGuard` with explicit `@Public()`, named throttlers counted in Redis through the `ratelimit` port: `default` on every route, `auth` only on the routes that declare `@Throttle({ auth: {} })` (login, refresh, the OAuth code exchange and both OAuth callbacks); a rejected request answers `RATE_LIMITED` with `Retry-After`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |

### Role matrix

`infra/opa/authz.rego` grants:

| Role     | `user`                                                       | `analytics`     |
| -------- | ------------------------------------------------------------ | --------------- |
| `admin`  | `create`, `read`, `list`, `update`, `delete`, `manage_roles` | `read`, `write` |
| `editor` | `read`, `update`                                             | `read`, `write` |
| `viewer` | `read`                                                       | `read`          |
| `member` | `read`, `update`                                             | none            |

- New accounts get `member` (`user.schema.ts`): read and update their own record, nothing else. Self sign-up can be open to anyone, so the default role grants the least; an admin grants more with `PATCH /api/users/:id/roles`.
- `create` is admin-only: anyone else gets an account only through self sign-up, under its policy and limits.
- `list` (FindAll, Search, FindSimilar, `GET /api/workflows/onboarding`) is separate from `read` and admin-only, because enumeration would otherwise let any sign-up list every user's email. `read` covers a single record, and the controller also requires owner-or-admin.
- The analytics live feed goes to the `admin`, `editor` and `viewer` role rooms only, because `member` holds no `analytics` permission.
- Writing `status` is admin-only (`assertMayWriteStatus` in `user.rpc.controller.ts`). Status gates sign-in, so an owner-writable status would let a suspended account restore itself.
- The first admin is created with `make promote-admin EMAIL=<email>` against the database; afterwards an admin changes roles with `PATCH /api/users/:id/roles`. `promote-admin` writes MongoDB directly; the token check reads roles from the member record on every request, so the grant applies to the next request.

### OAuth2 / SSO

Google and GitHub sign-in let users authenticate without a local password.

```
helm → sdk startOAuthSignIn: PKCE verifier in sessionStorage, challenge = base64url(SHA-256(verifier))
Browser → GET /api/auth/google?challenge=<challenge>      (no well-formed challenge → 400 VALIDATION_FAILED)
            └─ OAuthConfiguredGuard (provider credentials present, else 501) → Passport → consent screen
               state = nonce.exp.challenge.hmac; nonce also set in cookie tropis_oauth_state
               (HttpOnly, SameSite=Lax, Path=/api/auth, 10 min)
Google  → GET /api/auth/google/callback?code=...&state=...   (auth throttler)
            └─ SignedOAuthStateStore.verify: untampered, unexpired, nonce = cookie   else OAUTH_STATE_INVALID
            └─ GoogleStrategy.validate() → OAuthUserProfile { provider, providerId, email, emailVerified, name }
            └─ OAuthService.signIn(profile, challenge)   (tenant OAUTH_TENANT_ID, must be active)
                 1. find by (provider, providerId, tenantId)       ── found → that account
                 2. any account already holds the email            ── OAUTH_ACCOUNT_EXISTS, account untouched
                 3. otherwise UserService.signUpWithProvider: self sign-up policy + CreateUserCommand
                    (passwordHash '', default role, user.created on the outbox)
                 → one-time code in kv (60 s), bound to the challenge
            └─ redirect → <primary web origin>/auth/callback#code=<code>
helm /auth/callback → sdk completeOAuthSignIn → POST /api/auth/oauth/exchange { code, verifier }
            └─ code spent by the first attempt; SHA-256(verifier) = challenge; tenant and account still active
               → { accessToken } + tropis_rt refresh cookie   else OAUTH_CODE_INVALID
```

The session has the same format as password login, so all downstream code is provider-agnostic. No token ever appears in a URL: the callback carries only a one-time code, in the fragment, which never reaches a server log or a `Referer`. The state cookie binds the callback to the browser that started the flow, so an attacker cannot make a victim's browser finish a sign-in the attacker started; the PKCE challenge binds the code to the verifier only that browser holds, so a captured code is useless to anyone else, and the code is spent by its first exchange attempt, right or wrong, so the verifier cannot be guessed. An OAuth identity reaches only the account that provider created (same provider and subject): an email already held by any account is refused with `OAUTH_ACCOUNT_EXISTS` instead of linked, because without email verification on the Tropis side linking would hand the account to whoever registered the address first. The redirect goes to the primary web origin, never to a native-shell entry of the CORS list (native-shell limits: [deployment.md](deployment.md#native-distribution)). GitHub follows the same flow on `/api/auth/github`.

User schema fields for OAuth:

```typescript
provider?:   string  // 'google' | 'github'
providerId?: string  // provider-side ID (stable across renames)
```

OAuth-created users have `passwordHash: ''` and cannot log in with a password. Provider setup and callback URLs: [development.md](development.md).

## Secrets (Vault)

### Backend only

The browser never talks to Vault. The helm bundle contains only public URLs — `VITE_API_BASE_URL`, `VITE_RPC_URL`, `VITE_WS_URL`, `VITE_SITE_URL` (`src/lib/env.ts`) — and every operation that needs a credential (database, MinIO, Elasticsearch, JWT signing) runs in the backend.

```
Browser (helm) ──────────────────────────▶ Vault      never
Browser (helm) ──▶ NestJS backend ──▶ Vault            backend holds the token, returns only safe data
```

Rule: a value that would appear in the browser's network tab is not a secret, so no secret is ever sent to the browser.

### How the backend uses Vault

```
validatedConfigModule()   (roles/shared/validated-config.ts), before ConfigModule.forRoot validates the env
  └─ secretsLoaded()   (infrastructure/secrets/secrets-env.ts, once per process) → loadVaultSecretsIntoEnv()
                       (adapters/vault/vault-env-loader.ts, SECRETS_ADAPTER=vault)
       ├─ VAULT_ADDR unset       → nothing loaded, plain .env values used
       ├─ authenticate           VAULT_ROLE_ID + VAULT_SECRET_ID → AppRole login; else VAULT_TOKEN
       ├─ read VAULT_SECRET_PATH (default secret/data/tropis)
       │    copy each key into process.env only if it is not already set
       └─ any failure            → warning, the environment applies as it is
VaultSecretsAdapter.onModuleInit()   authenticates for the runtime API
  │    VAULT_ROLE_ID + VAULT_SECRET_ID → AppRole login, renew at 1/3 of the lease
  │    VAULT_TOKEN                     → static token, renewed on an interval below its 1 h increment
Runtime API
  ├─ encrypt/decrypt(key, value)   Transit engine (no caller in the app)
  ├─ getSecret(path, key)          single KV read
  └─ getDynamicDbCredentials()     database/creds/tropis-app → used by the relational (typeorm) module when available
```

Precedence is environment, then Vault, then the Joi default: the KV secrets are merged before validation, so Vault can supply any declared key (`JWT_SECRET`, `API_KEYS`, datastore credentials), and a key set in the environment always wins. Capability modules choose their driver connections after the same preload, so an adapter selector Vault supplies applies too. `infra/vault/init.sh` (run by the `vault-init` container) seeds the KV paths under `secret/tropis`, the `tropis-app` policy and AppRole, the `user-data` Transit key and the PostgreSQL database role, whose users are `NOSUPERUSER NOBYPASSRLS` members of `tropis_tenant_scope` so row-level security applies to them. Local setup: [development.md](development.md); production pattern: [deployment.md](deployment.md).

## Observability

| Concern     | Implementation                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Where                                                                                                               |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| Logs        | One logger port: `createLogger(module)` writes one JSON line per record in the OTel log data model (`time`, `level`, `msg`, `service.name`, `service.version`, `deployment.environment`, `service.role`, `host.name`, `process.pid`, `trace_id`, `span_id`, `tenant.id`, `module`, `event`, and `error.*` for errors). `event` is `<module>.<what-happened>` in kebab-case (`outbox.relay-lock-unavailable`); framework records get module `nest`. Each HTTP request is one record (module `http`, event `http.request-completed` or `http.request-failed`) with only `http.request.method`, `url.path` (no query string, which can carry codes), `http.response.status_code` and `http.server.request.duration` (seconds); the client address, user agent, headers and query are left out, and successful tracking ingest logs at debug. Application code never calls `console.*` (lint)                                                                                                                          | `common/observability/logger.ts`, `observability.module.ts`                                                         |
| Redaction   | Runs on every record: credentials (`authorization`, `cookie`, `password`, any key ending in `token`/`secret`/`password`, …) become `[redacted]`; emails become `sha256:<16 hex>`, so two records about one address still match                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | `common/observability/redaction.ts`                                                                                 |
| Tracing     | OpenTelemetry Node SDK with auto-instrumentations, OTLP HTTP → OTel Collector → Jaeger; service name `OTEL_SERVICE_NAME` (default `tropis-backend`), `service.role` from `SERVICE_ROLE`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | `src/tracing.ts` (imported before the app), `infra/otel/otel-collector.yaml`                                        |
| Correlation | The request id is the W3C trace id: HTTP echoes it in `x-request-id`, RPC in the `trace-id` header/trailer, and every problem body carries it as `traceId`. An incoming `x-request-id` is never adopted (a caller could collide or spoof ids); it is kept as the span attribute `http.request.header.x-request-id`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | `common/middleware/correlation-id.middleware.ts`, `common/observability/trace-context.ts`                           |
| Metrics     | `/metrics` on every role's ops port `OPS_PORT` (9464; Prometheus text format, prom-client default registry), never on the public HTTP port; Prometheus scrapes it every 15 s, plus the OTel Collector and the Pulsar broker                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | `src/common/observability/metrics.module.ts`, `src/modules/health/ops-server.ts`, `infra/prometheus/prometheus.yml` |
| Alerts      | Process health, HTTP and RPC error rate and p95 latency, outbox backlog/stall, consumer dead-lettering and failure rate, dead-lettered jobs, Pulsar DLQ backlog/rate → Alertmanager                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | `infra/prometheus/alerts.yml`                                                                                       |
| Dashboards  | Grafana with provisioned datasources (Prometheus, Jaeger, ClickHouse) and dashboards `backend-overview`, `tracking-analytics`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | `infra/grafana/`                                                                                                    |
| Health      | Ops port on every role: `/livez` (process only) and `/readyz`, used by the orchestrator. `/readyz` answers 503 `{status:'starting'}` until boot has finished, 503 from the moment shutdown begins, and otherwise runs only the role's required probes (`READINESS_PROBES` in `health.probes.ts`) plus the optional probes that cost no network round trip (`CHEAP_PROBES`: `consumers`): 503 while a required one is down, down optional ones listed in `degraded`, probe messages stripped. `GET /api/health` (public role, rate limited) runs every probe for the console's Stack page, with the same 503 rule and probe messages stripped from the 200 body. A probe run is reused for 3 s and a probe that has not answered in 3 s counts as down; the mail probe's SMTP handshake runs at most once per 60 s ([tech-decisions.md](tech-decisions.md#degradation-behavior)). A failing `/metrics` answers 500. `tropis.health.v1.HealthService` and the standard `grpc.health.v1.Health` on every RPC listener | `src/modules/health/`, `src/infrastructure/rpc/standard-health.ts`                                                  |

Required probes per role (`READINESS_PROBES`); every other probe is optional and only reported as `degraded`:

| Role        | Required                                                       |
| ----------- | -------------------------------------------------------------- |
| `public`    | `documents`, `cache`, `kv`, `ratelimit`, `policy`, `messaging` |
| `private`   | `documents`, `cache`, `kv`                                     |
| `worker`    | `documents`, `lock`, `dedup`, `messaging`, `consumers`, `jobs` |
| `scheduler` | `jobs`                                                         |
| `all`       | the union                                                      |

Why: a role is taken out of rotation only when it cannot serve at all; an outage of a store only some requests touch (search, OLAP, Temporal) degrades those requests instead of the whole role. Probe keys are capability names (`documents`, `relational`, `vector`, `search`, `olap`, `objects`, `graph`, `cache`, `kv`, `lock`, `ratelimit`, `dedup`, `messaging`, `consumers`, `jobs`, `workflow`, `realtime`, `secrets`, `policy`, `mail`, `signing`), each result carrying the `adapter` behind it, so a technology swap changes no key; there are no connection-level probes, because each capability probe exercises its connection. `consumers` is the exception that checks no store: it is down while a consumer the process started is not subscribed, so a worker whose subscriptions failed leaves rotation instead of looking healthy while consuming nothing. A role probes only the capabilities its modules load, and a required capability it does not load is not checked: whether a role uses a store is decided by the modules it composes, and removing a feature must not leave a probe that can never pass.

W3C Trace Context crosses every asynchronous boundary, so one trace runs from the request through the work it causes (helpers in `common/observability/propagation.ts`: `injectTraceContext` on the producer side, `runInExtractedSpan` on the consumer side, which also binds the trace id and tenant for log records):

| Boundary  | Producer side                                                                                                                                                                                                                               | Consumer side                                                                                              |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| RPC       | A caller that sends `traceparent` has its trace continued; otherwise the call starts one. `@tropis/sdk` sends `traceparent` on every Connect and REST call: from its `traceparent` option when that returns one, else a fresh root per call | the correlation interceptor opens the server span per call and echoes `trace-id` on the response           |
| Messaging | PRODUCER span `publish <topic>`; `traceparent`/`tracestate` message properties (`messaging.envelope.ts`)                                                                                                                                    | CONSUMER span `process <topic>`                                                                            |
| Outbox    | `OutboxService.write()` stores the request's `traceparent` on the row; the relay publishes in that context                                                                                                                                  | as messaging                                                                                               |
| Jobs      | PRODUCER span `publish <queue>`; the carrier travels in the job data under `__trace` (`jobs/job-trace.ts`)                                                                                                                                  | CONSUMER span `process <queue>` per attempt; handlers receive the data without `__trace` or `__tenant`     |
| Workflow  | Temporal client interceptor writes `traceparent`/`tracestate` into the workflow start headers                                                                                                                                               | workflow interceptors copy them onto every activity and child workflow; activity span `RunActivity:<type>` |

Metrics are named `tropis_<module>_<name>_<unit>` (`_total` for counters, a base unit otherwise) with bounded labels only: a route template, never a raw path; never a user, tenant or email. The RED metrics are recorded by the transports themselves, so every HTTP route and RPC method has them without code in the handler:

| Metric                                            | Type      | Labels / meaning                                                     | Recorded by                                                           |
| ------------------------------------------------- | --------- | -------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `tropis_http_server_requests_total`               | counter   | `method`, `route`, `status_class`                                    | `HttpMetricsMiddleware` (`common/middleware/`)                        |
| `tropis_http_server_duration_seconds`             | histogram | same labels                                                          | `HttpMetricsMiddleware`                                               |
| `tropis_rpc_server_requests_total`                | counter   | `service`, `method`, `code` (Connect code)                           | RPC metrics interceptor (`infrastructure/rpc/interceptors/`)          |
| `tropis_rpc_server_duration_seconds`              | histogram | same labels                                                          | RPC metrics interceptor                                               |
| `tropis_outbox_backlog_rows`                      | gauge     | open outbox backlog by `status`                                      | `OutboxRelay` (relay loop, once a minute per worker, and sweep)       |
| `tropis_outbox_published_total`                   | counter   | outbox events published to the broker                                | `OutboxRelay`                                                         |
| `tropis_outbox_publish_failed_total`              | counter   | failed publish attempts, by `result` (`failed`, `dead`)              | `OutboxRelay`                                                         |
| `tropis_messaging_processed_total`                | counter   | messages a consumer handled; `system`, `destination`, `subscription` | `consumeEnveloped` (`infrastructure/messaging/messaging.envelope.ts`) |
| `tropis_messaging_failed_total`                   | counter   | failed handling attempts (each redelivery counts), same labels       | `consumeEnveloped`                                                    |
| `tropis_messaging_dead_lettered_total`            | counter   | messages routed to `<topic>-DLQ`, same labels                        | Pulsar and Kafka adapters                                             |
| `tropis_jobs_completed_total`                     | counter   | completed job attempts by `queue`                                    | job attempt wrapper (`infrastructure/jobs/job-trace.ts`)              |
| `tropis_jobs_failed_total`                        | counter   | failed job attempts by `queue`                                       | job attempt wrapper                                                   |
| `tropis_jobs_dead_lettered_total`                 | counter   | jobs moved to `dead-letter` by `queue`                               | `BullmqWorkersService`                                                |
| `tropis_outbox_relay_last_poll_timestamp_seconds` | gauge     | heartbeat of the last completed relay poll                           | `OutboxRelay`                                                         |
| `tropis_tracking_duplicate_events_dropped_total`  | counter   | tracking events rejected by the ingest dedup claim                   | `TrackingService`                                                     |

RED metric names live in `common/observability/metrics.ts`; every other metric is a provider of the module that records it, named in that module's constants (`OUTBOX_BACKLOG_METRIC` in `infrastructure/outbox/outbox.constants.ts`, `MESSAGING_*_METRIC` in `infrastructure/messaging/messaging.metrics.ts`, `JOBS_*_METRIC` in `infrastructure/jobs/job-metrics.ts`, `TRACKING_DUPLICATES_METRIC` in `features/tracking/constants/`), which the alert rules reference. The outbox gauges are updated by the relay's own loop, so reliability visibility adds nothing to the request path. UI ports: [development.md](development.md).
