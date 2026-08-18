# Architecture

Full-stack overview of the Tropis monorepo: what runs, how data moves, and why.

## Components

| Component                    | Location                          | Role                                                                                                                                                                                                                                    |
| ---------------------------- | --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Backend API**              | `apps/backend/`                   | NestJS. Serves gRPC (public tier :50051, internal tier :50061), REST (`/api/v1`), WebSocket (Socket.io), health + metrics                                                                                                               |
| **Frontend — helm** (后台)   | `apps/frontend/helm/`             | Logged-in **admin console**. React 18 + Vite SPA (CSR), `noindex`. Talks gRPC-Web through Envoy; Socket.io for realtime. Ships as a static nginx image                                                                                  |
| **Frontend — harbor** (前台) | `apps/frontend/harbor/`           | Public **marketing/content site**. Next.js App Router (SSR/SSG), full SEO. Ships as a standalone Node server                                                                                                                            |
| **Temporal worker**          | `apps/temporal-worker/`           | Runs durable workflows (`src/workflows/`) and activities (`src/activities/`)                                                                                                                                                            |
| **Shared package**           | `packages/shared/`                | Types, DTOs, event contracts (`AppEvent`, `EVENT_TYPES`) consumed by backend, frontend, and Flink                                                                                                                                       |
| **Client SDK**               | `packages/sdk/`                   | `@tropis/sdk` — gRPC-Web client, REST helpers, realtime (Socket.io) client, tracking SDK, request-signing module; buf-generated proto types in `src/gen/`                                                                               |
| **Rust services**            | `services/rust/`                  | Cargo workspace; `signing/` gRPC service (`tropis.signing.v1`, port 50052, compose profile `rust`)                                                                                                                                      |
| **Flink jobs**               | `flink/`                          | Java/Maven. `PulsarToClickHouseJob` streams events into ClickHouse                                                                                                                                                                      |
| **Local infra**              | `infra/docker/docker-compose.yml` | All datastores, brokers, observability pipeline, admin UIs, and the Rust signing service — grouped into compose profiles (core / `analytics` / `observability` / `tools` / `rust`); see the compose file for the current container list |
| **Kubernetes**               | `infra/k8s/`                      | Base manifests + `overlays/prod` kustomize overlay (HPA, ingress)                                                                                                                                                                       |
| **CI/CD**                    | `.github/workflows/`              | `ci.yml` (lint/test/build/audit/SAST/secrets/quality), `deploy-prod.yml` (GHCR build + K8s deploy on tag), `publish.yml` (npm publish), `release-please.yml` (release PRs)                                                              |

## Data flow

```
                       ┌────────────────────────── Browser ──────────────────────────┐
                       │  React (Vite)                                                │
                       │   ├─ gRPC-Web ──► Envoy :8090 ──► NestJS gRPC :50051         │
                       │   ├─ REST (uploads / OAuth / SSE) ──► NestJS HTTP /api/v1    │
                       │   └─ Socket.io (realtime notifications) ◄──┐                 │
                       └────────────────────────────────────────────┼─────────────────┘
                                                                    │
        ┌───────────────────────── NestJS backend ──────────────────┴───────────────┐
        │                                                                           │
        │  Controllers (REST + gRPC) ─► Services ─► Repositories                    │
        │        │                        │                                         │
        │        │                        ├─► MongoDB (documents, event store)      │
        │        │                        ├─► PostgreSQL + pgvector (relational,    │
        │        │                        │      semantic search)                   │
        │        │                        ├─► Redis (cache, BullMQ, dedup)          │
        │        │                        ├─► Aerospike (sessions)                  │
        │        │                        ├─► Elasticsearch (full-text search)      │
        │        │                        ├─► MinIO (object storage)                │
        │        │                        └─► OPA (authorization decisions)         │
        │        │                                                                  │
        │  Write path (same Mongo transaction):                                     │
        │     domain write + outbox insert                                          │
        │        │                                                                  │
        │        ▼                                                                  │
        │  Outbox relay (src/infrastructure/outbox/outbox.relay.ts)                 │
        │        └──► MESSAGE_BROKER port (src/infrastructure/messaging/) ──► Pulsar │
        │                                                                           │
        │  Tracking ingest (POST /api/v1/track) ─► Pulsar ─► ClickHouse (see below) │
        │  Audit: @Audited handlers ─► AuditInterceptor ─► ClickHouse logs.audit_log │
        │  BullMQ queues (src/infrastructure/queue/) — notification, file-proc, DLQ │
        │  Temporal client (src/infrastructure/temporal/) ─► Temporal ─► worker app │
        └───────────────────────────────────────────────────────────────────────────┘
                                     │
                                     ▼
                     Pulsar ──► Flink (PulsarToClickHouseJob) ──► ClickHouse (OLAP)
                                                                       │
                                                                       ▼
                                                          Analytics queries / Grafana
```

## Transport strategy

**gRPC is the primary API transport.** Every business operation gets a gRPC method first (protos in `proto/<domain>/v1/`, per-module handlers in `modules/<feature>/controllers/*.grpc.controller.ts`, server plumbing in `src/infrastructure/grpc/`). The frontend calls it via gRPC-Web through the Envoy proxy (`infra/envoy/`).

REST (`/api/v1`) exists **only** for cases gRPC handles poorly:

| Use case                                              | Why REST                                                          |
| ----------------------------------------------------- | ----------------------------------------------------------------- |
| File uploads (multipart)                              | gRPC-Web has no good multipart/streaming upload story in browsers |
| OAuth2 callbacks (Google/GitHub, `src/modules/auth/`) | Providers redirect to HTTP URLs                                   |
| Inbound webhooks                                      | Third parties speak HTTP                                          |
| `/api/health`, `/api/metrics`                         | Kubernetes probes and Prometheus scrapers expect HTTP             |
| Server-Sent Events                                    | HTTP-native streaming                                             |

**WebSocket (Socket.io, `src/modules/websocket/`)** handles bidirectional realtime: in-app notifications and live updates. The gateway is JWT-authenticated.

Rule of thumb: if you are adding a REST endpoint and it's not on the list above, add a gRPC method instead.

## Event pipeline

1. **Write + outbox** — services never publish to Pulsar directly. They write the domain change and an outbox document (`src/infrastructure/outbox/outbox.schema.ts`) in the same MongoDB transaction, guaranteeing at-least-once delivery.
2. **Relay** — `outbox.relay.ts` polls unpublished outbox entries and publishes `AppEvent` (defined in `packages/shared/src/events/app-event.ts`) to Pulsar via the broker-agnostic `MESSAGE_BROKER` port (`src/infrastructure/messaging/`).
3. **Pulsar** — the cross-service event bus. Consumers must tolerate unknown fields (add-only payload evolution; see `docs/api-versioning.md`). Each module owns a **durable Pulsar consumer** for its at-least-once side-effects: e.g. `modules/user/processors/user.processor.ts` performs the Elasticsearch index, pgvector upsert, welcome email, and counter/cache off the outbox (idempotent via a Redis `SET NX` dedup on eventId). In-process EventEmitter handlers (`modules/user/events/user-event.handlers.ts`) are reserved for **ephemeral** effects only — realtime WebSocket broadcasts — where a dropped event is not a consistency bug.
4. **Flink** — `flink/src/main/java/com/app/flink/jobs/PulsarToClickHouseJob.java` deserializes events and sinks them into ClickHouse.
5. **ClickHouse** — append-only analytics store (init SQL in `infra/clickhouse/`).

In parallel:

- **BullMQ** (`src/infrastructure/queue/`) — short, retryable background jobs within the backend: notifications, file processing, plus a dead-letter queue.
- **Temporal** (`src/infrastructure/temporal/` + `apps/temporal-worker/`) — long-running, durable, multi-step workflows (e.g. `notification.workflow.ts`), surviving restarts and supporting sagas/compensation.

See `docs/tech-decisions.md` for when to pick which.

## Observability

| Concern    | Tool                                                                                                                                       | Where                                                            |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------- |
| Tracing    | OpenTelemetry SDK → OTel Collector → Jaeger                                                                                                | `apps/backend/src/tracing.ts` (loaded before app), `infra/otel/` |
| Metrics    | Prometheus scraping `/api/metrics` + OTel Collector                                                                                        | `src/modules/metrics/`, `infra/prometheus/prometheus.yml`        |
| Dashboards | Grafana (auto-provisioned datasources)                                                                                                     | `infra/grafana/provisioning/`, UI at `localhost:3101`            |
| Health     | `/api/health` with per-dependency indicators (Mongo, Redis, ClickHouse, PG, ES, MinIO, OPA, Temporal, Pulsar) + gRPC `HealthService.Check` | `src/modules/health/`                                            |
| Logs       | Structured JSON via nestjs-pino                                                                                                            | backend-wide                                                     |

## Security & policy

- **Vault** (`infra/vault/`, `src/infrastructure/vault/`) — secrets at runtime; dev compose runs it in dev mode with `vault-init`.
- **OPA** (`infra/opa/authz.rego`, `src/infrastructure/opa/`) — externalized authorization: role → resource → action.
- **JWT auth** (`src/modules/auth/`) — Passport local + JWT, OAuth2 via Google/GitHub strategies; login lockout (5 fails/15 min per email+IP, `login-lockout.service.ts`); sessions in Aerospike.
- **Audit logging** — `@Audited()` decorator + `AuditInterceptor` (`src/common/`) write sensitive-action records to ClickHouse `logs.audit_log` via `modules/audit/` (schema: `infra/clickhouse/init-audit.sql`).
- Helmet, CORS allowlist (`src/config/cors.constants.ts`), global ValidationPipe in `main.ts`.

## User-behavior tracking (埋点)

```
SDK tracker (packages/sdk/src/tracking/) ──batch──► REST POST /api/v1/track (202, public, rate-limited)
  ──► TrackingService ──direct──► Pulsar "tracking-events" ──► TrackingProcessor ──► ClickHouse logs.user_behavior
                                                                     │
Dashboard (/behavior) ◄── gRPC TrackingService.GetInsights (auth) ◄──┘
```

- **Ingest is REST** — the tracker flushes on page unload via `navigator.sendBeacon`, which can only POST plain HTTP (this is an approved REST exception; reads stay gRPC).
- **Direct-to-Pulsar, no outbox** — tracking is lossy-tolerant (see `docs/tech-decisions.md`).
- Module: `apps/backend/src/modules/tracking/`; proto: `proto/tracking/v1/tracking.proto`; table: `infra/clickhouse/init-tracking.sql`. Flink is the scale-out alternative to the Node processor.
