# Technology Decisions

Which technology does which job in this foundation, when to use it, when not
to, and what happens when it is down. Every datastore, broker and tool here
exists for one distinct role.

Golden rule: **pick the tool by access pattern, not by familiarity.** When two
tools could work, the decision tables below settle it.

Backend paths are relative to `apps/backend/src/` unless they start with
`apps/`, `infra/`, `packages/`, `services/` or `proto/`. Compose
services live in `infra/docker/docker-compose.yml`; a service with no profile
starts with the core stack. How to start each profile and open the admin UIs:
[development.md](development.md). System-level data flow:
[architecture.md](architecture.md).

---

## Responsibility map

Every external system sits behind a capability port in
`infrastructure/<capability>/` (`<capability>.port.ts` + DI token), with one
directory per technology under `adapters/` ([project-structure.md](project-structure.md)).

| Responsibility                 | Technology                                                                                                 | Where it lives                                                                                                                                     | Compose service (profile)                                           |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| Primary store                  | MongoDB (Mongoose)                                                                                         | `infrastructure/documents/` (tenant fence `tenant-scope.ts`), each module's `repositories/` and `schemas/`; outbox in `infrastructure/outbox/`     | `mongodb` (single-node replica set `rs0`)                           |
| Relational                     | PostgreSQL (TypeORM) behind `RELATIONAL`, row-level security per tenant                                    | `infrastructure/relational/adapters/typeorm/`; migrations in `apps/backend/migrations/` (node-pg-migrate)                                          | `postgres` (relational)                                             |
| Vector similarity              | pgvector behind `VECTOR`                                                                                   | `infrastructure/vector/adapters/pgvector/`                                                                                                         | `postgres` (relational)                                             |
| Full-text search               | Elasticsearch behind `SEARCH`                                                                              | `infrastructure/search/adapters/elasticsearch/`                                                                                                    | `elasticsearch` (search); `kibana` (tools)                          |
| Analytics store                | ClickHouse behind `OLAP`                                                                                   | `infrastructure/olap/adapters/clickhouse/`, `features/analytics/`, `features/tracking/`, `common/audit/`; DDL in `infra/clickhouse/`               | `clickhouse` (olap); `clickhouse-ui`, `metabase` (tools)            |
| Cache, lock, rate limit, dedup | Redis (ioredis) behind `CACHE`, `LOCK`, `RATE_LIMIT`, `DEDUP`                                              | `infrastructure/{cache,lock,ratelimit,dedup}/adapters/redis/`; shared client `infrastructure/connections/redis/`                                   | `redis`; `redisinsight` (tools)                                     |
| Key/value                      | Redis (default) or Aerospike behind `KV`                                                                   | `infrastructure/kv/adapters/{redis,aerospike}/`; Aerospike client `infrastructure/connections/aerospike/`                                          | `redis`; `aerospike` (kv-scale)                                     |
| Object storage                 | S3 API behind `OBJECTS`: managed S3 in production, MinIO locally                                           | `infrastructure/objects/adapters/minio/`                                                                                                           | `minio` (objects)                                                   |
| Event bus                      | Apache Pulsar (default) or Kafka behind `MESSAGING`                                                        | `infrastructure/messaging/adapters/{pulsar,kafka}/`; relay in `infrastructure/outbox/outbox.relay.ts`                                              | `pulsar`; `kafka` (kafka); `pulsar-manager` (tools)                 |
| Background jobs                | BullMQ (on Redis) behind `JOBS`                                                                            | `infrastructure/jobs/adapters/bullmq/`; Bull Board at `/api/queues` (`all` role, outside production, localhost only)                               | uses `redis`                                                        |
| Durable workflows              | Temporal behind `WORKFLOW` (client in every role, worker in the worker role)                               | `infrastructure/workflow/adapters/temporal/`                                                                                                       | `temporal`, `postgresql-temporal` (workflow); `temporal-ui` (tools) |
| Stream processing              | Apache Flink (Java) or the Node `AnalyticsProcessor`, one at a time (`STREAM_ENGINE`)                      | `services/flink/` (`PulsarToClickHouseJob`), `features/analytics/processors/`                                                                      | `flink-jobmanager`, `flink-taskmanager` (stream)                    |
| Realtime push                  | Socket.io behind `REALTIME` (Redis adapter + emitter across processes)                                     | `infrastructure/realtime/`; gateway `modules/websocket/gateways/notification.gateway.ts` (namespace `/ws`)                                         | `redis`                                                             |
| Relationship graph             | Neo4j Community behind `GRAPH` (openCypher only)                                                           | `infrastructure/graph/`; membership projection `features/membership-graph/`                                                                        | `neo4j` (graph)                                                     |
| Service API                    | RPC over the proto contracts, served with Connect (Connect, gRPC, gRPC-Web on one port) + REST gap-fillers | `proto/`, `infrastructure/rpc/`, each module's `controllers/`                                                                                      | `grpcui` (tools)                                                    |
| Browser transport              | Connect protocol, straight to the backend's public RPC listener                                            | `infrastructure/rpc/rpc-cors.ts`; client in `packages/sdk/src/client/`                                                                             | in the backend process                                              |
| Authentication                 | JWT + Passport (local, Google, GitHub), one `TokenVerifier`                                                | `modules/auth/`, port `common/auth/token-verifier.port.ts`                                                                                         | in the backend process                                              |
| Authorization                  | OPA (Rego) behind `POLICY`                                                                                 | `infrastructure/policy/adapters/opa/`, policy `infra/opa/authz.rego`                                                                               | `opa`                                                               |
| Secrets and encryption         | HashiCorp Vault (KV, database creds) behind `SECRETS`                                                      | `infrastructure/secrets/adapters/{vault,env}/`, bootstrap `infra/vault/init.sh` + `policy.hcl`                                                     | `vault`, `vault-init` (secrets)                                     |
| Email / SMS                    | Nodemailer to SMTP (Mailpit locally) behind `MAIL`; SMS stub                                               | `infrastructure/mail/adapters/{smtp,log}/`, `modules/notification/services/notification.service.ts`                                                | `mailpit`                                                           |
| Request signing                | HMAC-SHA256 behind `SIGNING`: in process, or the Rust service                                              | `infrastructure/signing/adapters/{inprocess,native}/`, `services/rust/signing/`                                                                    | `signing` (signing)                                                 |
| Tracing                        | OpenTelemetry SDK to OTel Collector to Jaeger                                                              | `tracing.ts`, `infra/otel/otel-collector.yaml`                                                                                                     | `otel-collector`, `jaeger` (observability)                          |
| Metrics and alerts             | Prometheus + Alertmanager + Grafana                                                                        | `common/observability/metrics.module.ts`, `common/observability/metrics.ts` (`:9464/metrics`, the ops port), `infra/prometheus/`, `infra/grafana/` | `prometheus`, `alertmanager`, `grafana` (observability)             |
| Logs                           | Pino behind the logger port (`createLogger`)                                                               | `common/observability/`                                                                                                                            | `dozzle` (tools)                                                    |
| Console frontend               | React 18 + Vite SPA: helm (the console)                                                                    | `apps/frontend/helm/`                                                                                                                              | not in compose                                                      |
| Public site frontend           | Next.js 15 App Router (`harbor`)                                                                           | `apps/frontend/harbor/`                                                                                                                            | not in compose                                                      |

### Adapter selection

Each capability picks its adapter from one environment variable, validated in
`config/env.validation.ts`, so a deployment changes technology without a code
change and a capability it does not use costs nothing:

| Variable             | Values (default first)           | Variable            | Values (default first)        |
| -------------------- | -------------------------------- | ------------------- | ----------------------------- |
| `CACHE_ADAPTER`      | `redis`, `disabled`              | `SEARCH_ADAPTER`    | `elasticsearch`, `disabled`   |
| `KV_ADAPTER`         | `redis`, `aerospike`, `disabled` | `OLAP_ADAPTER`      | `clickhouse`, `disabled`      |
| `LOCK_ADAPTER`       | `redis`, `disabled`              | `OBJECTS_ADAPTER`   | `minio`, `disabled`           |
| `RATE_LIMIT_ADAPTER` | `redis`, `disabled`              | `WORKFLOW_ADAPTER`  | `temporal`, `disabled`        |
| `DEDUP_ADAPTER`      | `redis`, `disabled`              | `SECRETS_ADAPTER`   | `vault`, `env`                |
| `GRAPH_ADAPTER`      | `disabled`, `neo4j`              | `MAIL_ADAPTER`      | `smtp`, `log`                 |
| `REALTIME_ADAPTER`   | `redis`, `local`                 | `SIGNING_ADAPTER`   | `inprocess`, `native`         |
| `VECTOR_ADAPTER`     | `pgvector`, `disabled`           | `MESSAGING_ADAPTER` | `pulsar`, `kafka`, `disabled` |
| `STREAM_ENGINE`      | `node`, `flink`                  |                     |                               |

A `disabled` adapter throws `CapabilityDisabledError` from every call and
reports health `disabled` (up, with `disabled: true`), because switching a
capability off is a configuration choice that must never fail a health
check. The exception is the cache: cached data is optional by definition, so
the disabled cache is a pass-through (every read misses, writes are dropped,
`getOrLoad` runs the loader). `local` realtime, `env` secrets and `log` mail are the single-node or
development stand-ins: in-process delivery only, no encryption (callers
redact), and mail written to the log.

---

## Data storage

### MongoDB vs PostgreSQL

|               | MongoDB                                                                                                                                                   | PostgreSQL                                                                                                                                |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| What          | Document store, the system of record                                                                                                                      | Relational ACID database with the pgvector extension                                                                                      |
| Holds         | Users (`modules/user/schemas/user.schema.ts`), the `tenants` directory, the append-only `user_event_store`, the `outbox` collection, analytics event logs | The pgvector `vector_embeddings` table and every row-level-security policy, created by the migrations (`apps/backend/migrations/`)        |
| Use for       | Flexible or nested documents whose shape evolves, event logs, the outbox (business write + outbox row in one Mongo transaction)                           | Relational or money-adjacent data: orders, payments, ledgers, invariants enforced by constraints and multi-table transactions; embeddings |
| Don't use for | Multi-row financial invariants, cross-entity joins, strict schemas: use PostgreSQL                                                                        | High-churn schemaless payloads and event logs: use MongoDB                                                                                |

Rule: **if losing or double-counting a row costs money, it goes in PostgreSQL**,
because constraints and multi-row transactions enforce the invariant. If the
shape of the data is the volatile part, it goes in MongoDB.

MongoDB runs as a replica set (`--replSet rs0`, also in compose) because the
outbox write in `modules/user/commands/*.command.ts` runs in
`DocumentsPort.withTransaction()`, a MongoDB transaction, which needs one. PostgreSQL schema changes go
through migrations (`make migrate`); `TYPEORM_SYNC` stays off outside local
experiments, because TypeORM `synchronize` can silently drop columns.

### Redis vs Aerospike

|               | Redis                                                                                                                                                                                                                                                                                                                                                                                                                                        | Aerospike                                                                                                                                                                  |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| What          | In-memory data-structure store                                                                                                                                                                                                                                                                                                                                                                                                               | Distributed KV store, index in RAM and data on SSD, per-record TTL                                                                                                         |
| Holds         | Every `cache`, `lock`, `ratelimit` and `dedup` key: user profile cache (5 min; never used for access decisions, which the token verifier reads from MongoDB on every call), tenant record cache (60 s), analytics stats cache (30 s), outbox aggregate leases, login, RPC-login, sign-up and HTTP throttler counters, consumer and signature-nonce dedup claims; the `kv` keys by default; BullMQ queues; the realtime Redis adapter channel | The `kv` keys when `KV_ADAPTER=aerospike`: revoked token ids, refresh tokens, suspension and lockout markers, session records (7 days), idempotent create responses (24 h) |
| Use for       | Caching, queues, counters, locks, dedup, anything that can be rebuilt if lost                                                                                                                                                                                                                                                                                                                                                                | Pure KV that is latency-critical and expected to outgrow one Redis node's memory                                                                                           |
| Don't use for | Datasets larger than RAM, strict sub-ms p99 at very high concurrency: use Aerospike                                                                                                                                                                                                                                                                                                                                                          | Rich structures (lists, sorted sets), queues, Lua scripts: use Redis                                                                                                       |

Rule: **default to Redis.** Reach for Aerospike only when the workload is pure
KV, latency-critical and larger than a Redis node's memory; the `kv` port
makes that a `KV_ADAPTER` switch, not a code change.

The Aerospike client is optional:
`infrastructure/connections/aerospike/aerospike-connection.module.ts` loads the
package with a dynamic `require` and yields a `null` client when the package or
server is missing. It reads `AEROSPIKE_HOSTS`, a comma-separated `host:port`
list (default `localhost:3000`).

### Elasticsearch vs pgvector

|               | Elasticsearch                                                                                                                       | pgvector                                                                                                                                        |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| What          | Inverted-index search engine                                                                                                        | Vector similarity inside PostgreSQL                                                                                                             |
| Holds         | The users index, kept in sync by `modules/user/processors/user.processor.ts` and queried by `modules/user/services/user.service.ts` | `vector_embeddings.embedding vector(384)` (collection `user-profile`) with an ivfflat cosine index, served by the `UserService.FindSimilar` RPC |
| Use for       | Full-text search, fuzzy matching, typo tolerance, facets, keyword relevance scoring                                                 | Semantic similarity ("find users like this one", RAG retrieval), filtered by ordinary SQL `WHERE` clauses                                       |
| Don't use for | Similarity by meaning, where keywords miss synonyms: use pgvector                                                                   | Keyword or fuzzy lookups: use Elasticsearch                                                                                                     |

The embeddings are derived deterministically from the user profile inside
`modules/user/services/user-similarity.service.ts`; no embedding model is
called. Both
indexes are derived data and can be rebuilt from MongoDB.

### ClickHouse (analytics store)

- **What**: columnar OLAP database.
- **Use when**: append-only analytics: event counts, funnels, time-series aggregations over millions of rows.
- **Not for**: rows you UPDATE/DELETE individually, transactional reads or single-row lookups: use MongoDB or PostgreSQL.
- **Tables** (`infra/clickhouse/*.sql`): `logs.analytics_events` and the `logs.analytics_minutely` materialized view into `logs.analytics_minutely_agg` (written by `features/analytics/services/analytics-sink.service.ts`), `logs.user_behavior` (tracking, `features/tracking/services/tracking-sink.service.ts`), `logs.audit_log` (`common/audit/`). With `STREAM_ENGINE=flink` the Flink job writes `logs.analytics_events` instead of the processor.
- **Tenancy**: every `logs.*` table leads its `ORDER BY` with `tenant_id`; the OLAP port's fence is in [architecture.md](architecture.md#store-fences).
- **BI**: Metabase (`metabase`, tools profile) and the Grafana ClickHouse datasource query it directly; reference queries live in `infra/clickhouse/queries/`.

### MinIO (object storage)

- **What**: S3-compatible object storage. **Use when**: uploads, images, exports, anything blob-shaped. **Not for**: structured data or small hot values.
- **In use**: user avatar upload and presigned URL routes in `modules/user/controllers/user.controller.ts`, through the `OBJECTS` port. Configured by the `MINIO_*` variables ([development.md](development.md#environment-variables)).
- **Production**: a managed S3 service (AWS S3, Cloudflare R2, GCS in S3 mode) through the same S3-protocol adapter (`OBJECTS_ADAPTER=minio`, the `MINIO_*` variables pointing at the provider). No MinIO server runs in production, because MinIO publishes no official images; the pinned `pgsty/minio` build serves local development and tests only ([deployment.md](deployment.md#production-configuration)).

---

## Messaging and async

### Event bus: Pulsar behind the MessagingPort

- **What**: distributed pub/sub broker, the cross-service event bus.
- **Use when**: a fact happened that other services or sinks may care about (`identity.user.created`, analytics events). Domain events are always published **via the outbox** (`infrastructure/outbox/`); business code never calls a producer directly.
- **Not for**: internal background work (BullMQ), request/response (gRPC), orchestration (Temporal).
- **Topics**: logical names `user-events`, `analytics-events`, `tracking-events`; the Pulsar adapter maps each to `persistent://public/default/<topic>` (and its dead-letter topic to `…-DLQ`), Kafka uses the name as is, so topic constants carry no technology. Consumers: [architecture.md](architecture.md#event-pipeline).

The broker is behind a broker-agnostic port in `infrastructure/messaging/`:

| File                                                        | Role                                                                                                                                                                                                                                                                                                                                                                          |
| ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `messaging.port.ts`                                         | `MessagingPort` (`publish` / `subscribe` / `close`), the `MESSAGING` token and `MESSAGING_ACK_TIMEOUT_MS`. Handler contract: resolve = ack, throw = redelivery with a doubling delay, after the last redelivery `<topic>-DLQ`, kept for the subscription `<subscription>-DLQ`, in every adapter; redelivery policy in [architecture.md](architecture.md#reliability-patterns) |
| `event-consumer.ts`                                         | `EventConsumer`: the consumer side for every subscriber — JSON decoding, envelope tenant binding and rejection of data naming another tenant, and claim-then-commit dedup (`once`, `onceEach`)                                                                                                                                                                                |
| `messaging.envelope.ts`                                     | CloudEvents binary-mode envelope and W3C trace propagation, shared by every adapter                                                                                                                                                                                                                                                                                           |
| `adapters/pulsar/`, `adapters/kafka/`, `adapters/disabled/` | Pulsar (default; client from `connections/pulsar/`), Kafka (own kafkajs client, `KAFKA_BROKERS`), and `disabled`                                                                                                                                                                                                                                                              |
| `messaging.module.ts`                                       | `MessagingModule.forRoot()`; selects the adapter from `MESSAGING_ADAPTER` and opens the Pulsar connection only for `pulsar`                                                                                                                                                                                                                                                   |

Rules:

- Only `outbox.relay.ts`, `EventConsumer` and `TrackingService` inject `MESSAGING`; the four processors (`UserProcessor`, `MembershipGraphProcessor`, `AnalyticsProcessor`, `TrackingProcessor`) subscribe through `EventConsumer`. The user and analytics services write the outbox and never touch the broker.
- The Pulsar client (`PULSAR_CLIENT`, `connections/pulsar/`) is reached only by the Pulsar adapter; dependency-cruiser blocks modules from importing connections.
- Adding another broker means one adapter implementing the port and passing `messaging.conformance.ts`, a `case` in `messaging.module.ts` and the value in the `MESSAGING_ADAPTER` `valid()` list; consumers do not change.

Delivery guarantees (outbox relay, consumer DLQ, replay safety):
[architecture.md](architecture.md#reliability-patterns).

### Background jobs vs durable workflows: BullMQ vs Temporal

|               | BullMQ                                                                                                                                                                                                                                 | Temporal                                                                                                                                                                                                                                                                                                                                                                                                    |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| What          | Redis-backed job queue                                                                                                                                                                                                                 | Durable workflow engine                                                                                                                                                                                                                                                                                                                                                                                     |
| Runs          | Queues `notification` (3 attempts, exponential backoff from 2 s), `outbox-maintenance` (the outbox sweep) and `dead-letter` (replayed with `make jobs-dlq-replay`). The welcome email uses the deterministic job id `welcome-<userId>` | `userOnboardingWorkflow`: a durable timer (`ONBOARDING_FOLLOWUP_DELAY_MS`) then a follow-up email activity (5 attempts). Started by `OnboardingService` on `identity.user.created`                                                                                                                                                                                                                          |
| Use for       | Short, retryable, fire-and-forget jobs: send an email, resize an image                                                                                                                                                                 | Long-running, multi-step, stateful work: sagas with compensation, human-in-the-loop steps, durable timers, anything that must survive a deploy mid-flight                                                                                                                                                                                                                                                   |
| Don't use for | Multi-step orchestration where a later step depends on an earlier result and the process can take hours: use Temporal                                                                                                                  | A single retryable task; the worker, task queue and versioning overhead is not worth it: use BullMQ                                                                                                                                                                                                                                                                                                         |
| Where         | `JOBS` port, `infrastructure/jobs/`; each owning module declares its queues and their policies with `JobsModule.forFeature()`; Bull Board at `/api/queues` (`all` role, outside production, localhost only)                            | `WORKFLOW` port, `infrastructure/workflow/`: client (`adapters/temporal/temporal-client.provider.ts`) and the worker-role workers (`workflow-worker.module.ts`, `adapters/temporal/temporal-worker.service.ts`, one per registered queue); the workflows and activities belong to their module (`modules/user/workflows/`), registered with `WorkflowModule.forFeature` / `WorkflowWorkerModule.forFeature` |

Decision question: **"if the process crashes halfway, does partial completion
matter?"** Yes: Temporal. No, the whole job is safe to retry: BullMQ. Rule of
thumb for duration: BullMQ for jobs of seconds to minutes, Temporal for work of
minutes to days.

Dead-lettering of exhausted jobs: [architecture.md](architecture.md#dead-letter-handling).

### Stream processing: Flink

- **What**: stream processing engine (Java, `services/flink/`, compose `stream` profile).
- **In use**: `PulsarToClickHouseJob` reads `analytics-events` on its own subscription (`flink-clickhouse-sub`), takes the tenant from the envelope (`ce_tenantid`), drops events without an `eventType` or tenant, and micro-batches rows into `logs.analytics_events`.
- **One owner (`STREAM_ENGINE=node|flink`, default `node`)**: exactly one engine writes analytics events to OLAP. `node`: `AnalyticsProcessor` subscribes and writes, deduplicating on the domain `eventId`; the Flink job must not be submitted. `flink`: `AnalyticsProcessor` does not subscribe (it logs `analytics.olap-writer-external` once at startup) and the Flink job writes; the console's live `analytics.event` push then stops, since only the processor sends it. Why: MergeTree does not deduplicate, so two writers double every count, and a second table would split the read model the console queries. The Flink path is at-least-once through its checkpoints (every 10 s), so a job restart can replay rows since the last checkpoint.
- **Use when**: continuous transformation of a stream that one Node consumer cannot keep up with: windowing, joins, enrichment.
- **Not for**: one-off batch jobs or per-request logic.

## Tracking (user behavior instrumentation)

Two deliberate deviations from the defaults above, both scoped to `features/tracking/`:

1. **Direct to the broker, no outbox.** The outbox guarantees at-least-once delivery of _domain_ events. Behavioral tracking is high-volume and lossy-tolerant; routing every beacon through a MongoDB transaction would double the write load of the hottest endpoint. `TrackingService.ingest()` drops already-seen `eventId`s per tenant, publishes to `tracking-events` and logs, never surfaces, a publish failure. Domain events still go through the outbox.
2. **REST ingest, RPC reads.** The SDK tracker flushes on `visibilitychange:hidden` / `pagehide` with `navigator.sendBeacon`, which can only POST plain HTTP. Ingest is therefore `POST /api/v1/track` (public, validated, answers 202) and `POST /api/v1/track/secure` (HMAC-signed, see [api-conventions.md](api-conventions.md)); the read surface `TrackingService.GetInsights` is an RPC.

Sink: `TrackingProcessor` batch-inserts into ClickHouse `logs.user_behavior`
and nudges dashboards through the realtime port. It takes no dedup claim, so a
Pulsar redelivery inserts the batch again; a failed push is logged and does not
nack the batch. The Flink job consumes `analytics-events` only, not `tracking-events`. Event names are governed contracts:
[tracking-plan.md](tracking-plan.md).

---

## APIs, realtime and gateway

| Technology | Role                                                                                                                                                                                                                                                                                                                                                                         |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| RPC        | Primary API: Protocol Buffers in `proto/` governed by buf, typed contracts for every business call, served by `RpcServer` (`infrastructure/rpc/`) over Connect, gRPC and gRPC-Web on the same port. Public tier on `RPC_PUBLIC_PORT` (50051), internal tier on `RPC_INTERNAL_PORT` (50061)                                                                                   |
| REST       | Gap-fillers only, each with a stated reason (uploads, OAuth redirects, beacons, probes and scrapes, browser session endpoints, …). The full exception list and the rule for new endpoints: [api-conventions.md](api-conventions.md)                                                                                                                                          |
| Connect    | Browsers cannot speak native gRPC, so they use the Connect protocol: plain HTTP/1.1 requests with no trailers, answered by the backend's public RPC listener directly with no translating proxy. CORS in `infrastructure/rpc/rpc-cors.ts`, client in `@tropis/sdk`                                                                                                           |
| Socket.io  | Server push without polling: domain-event toasts, live analytics feed, onboarding notices. Behind the `REALTIME` port because the worker, scheduler and public roles are separate processes and only public holds sockets; the Redis emitter and adapter let any process reach them. Rooms, token checks and adapters: [architecture.md](architecture.md#transport-strategy) |

## Notifications

| Channel     | Technology                                                                           | Behavior                                                                                    |
| ----------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------- |
| Email       | `MAIL` port: Nodemailer to SMTP (`SMTP_HOST`, `SMTP_PORT`, …), or `MAIL_ADAPTER=log` | Mailpit traps all mail locally. Welcome email via BullMQ, onboarding follow-up via Temporal |
| SMS         | Stub                                                                                 | `NotificationService.sendSms()` logs the message; no SMS provider client is wired           |
| In-app push | `RealtimePort.publishToUser()` (Socket.io)                                           | Delivered while the user has the console open                                               |

## Security services

Authentication, tenancy and RBAC:
[architecture.md](architecture.md#authentication-and-authorization) and
[architecture.md](architecture.md#multi-tenancy); the policy is
`infra/opa/authz.rego`. This doc covers only which service does which job.

### Authorization: OPA

- **What**: externalized policy engine (Rego). **Use when**: role, resource, action decisions, so policy changes need no app redeploy. **Not for**: authentication, which is `modules/auth/` (JWT + Passport).
- **Where**: the `PolicyPort` (`POLICY`, `infrastructure/policy/policy.port.ts`) with the OPA adapter `infrastructure/policy/adapters/opa/opa-policy.adapter.ts`; policy `infra/opa/authz.rego`; RPC gate `infrastructure/rpc/rpc-authz.service.ts`.
- **Failure rule**: 2 s timeout, and a circuit breaker (`common/circuit-breaker/circuit-breaker.ts`) opens after 5 consecutive failures (timeouts, network errors, non-2xx answers) for 30 s, then lets a single probe call through. Every failure path (timeout, non-2xx, open circuit) is `SERVICE_UNAVAILABLE` (503, retryable), never a denial, so an outage is retried instead of being reported as missing permission; only an answer from OPA allows or denies.
- **Engine auth**: with `OPA_TOKEN` set the adapter sends it as a bearer token, for an OPA run with `--authentication=token`.

### Secrets: Vault

- **What**: secrets manager with KV secrets and dynamic database credentials. **Use when**: any credential, API key or signing secret; never hardcode or commit one.
- **Where**: `SECRETS` port, adapter `infrastructure/secrets/adapters/vault/vault-secrets.adapter.ts` (`SECRETS_ADAPTER=vault`; `env` reads the environment only); behavior: [architecture.md](architecture.md#secrets-vault).
- **Production pairing**: External Secrets Operator (`infra/k8s/base/backend/external-secret.yaml`), see [deployment.md](deployment.md).

### Request signing

HMAC-SHA256 server-to-server signatures are checked by
`common/guards/signature.guard.ts` (nonces through the `DEDUP` port) through the
`SIGNING` port: in process by default (`SIGNING_ADAPTER=inprocess`), or by the
Rust `signing` service with `SIGNING_ADAPTER=native` (`SIGNING_SERVICE_URL`,
same `API_KEYS` on both sides). Spec:
[api-conventions.md](api-conventions.md#request-signing-server-to-server-rest).

---

## Rust vs TypeScript

The monorepo is proto-first, so services are language-agnostic at the contract
level. **TypeScript is the default for everything**; Rust is the exception for
profiled CPU-bound hot paths, confined to `services/`. The backend is
TypeScript/NestJS.

|               | TypeScript (default)                                                                                                                                                      | Rust (exception)                                                                                                                                             |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Use for       | All business logic, CRUD, orchestration and IO-bound work, where DB, broker and HTTP calls dominate latency. One language, shared types (`@tropis/shared`, `@tropis/sdk`) | A **profiled** CPU-bound hot path: crypto, compression, image or video processing, line-rate parsing; sustained single-digit-ms p99 under load; WASM targets |
| Don't use for | A CPU-bound inner loop that profiling shows dominates a service and cannot be fixed in Node                                                                               | Anything with business rules, evolving schemas or heavy I/O; the toolchain cost buys nothing                                                                 |
| Where         | `apps/backend`, `apps/frontend/*`, `packages/*`                                                                                                                           | `services/rust/signing/`: the reference service (HMAC-SHA256 compute and verify, stateless), called by the backend's `native` signing adapter                |

**All must hold before writing Rust:**

1. **Profile first.** A flamegraph or `clinic` profile shows a CPU-bound hot path dominating the service.
2. **Node options are exhausted.** `worker_threads`, a native addon (napi-rs / N-API) or an existing optimized npm package did not solve it. Most npm crypto and compression packages already bind to C or Rust, so a rewrite rarely beats them.
3. The hot path is **isolatable behind a proto contract** with no shared business state.

**Integration path** (no changes to existing services):

1. Define the contract in `proto/<domain>/v1/`; buf lint and breaking checks gate it like any other proto.
2. `make proto` regenerates the TypeScript SDK; the Rust crate compiles the same file in `build.rs`.
3. Expose it over gRPC; existing services gain another peer.
4. Follow `services/rust/signing/`: contract `proto/signing/v1/signing.proto`, standard `grpc.health.v1` probes, JSON logs, compose `signing` profile, membership in the root Cargo workspace (covered by the `rust` CI job). Crate layout: [project-structure.md](project-structure.md).

**Costs (why the bar is high):** another toolchain in CI and on laptops
(alongside Node and Java for Flink), a smaller review pool, duplicated
conventions (logging, health, config), and cross-language test vectors that
must stay in sync
([api-conventions.md](api-conventions.md#request-signing-server-to-server-rest)).

---

## Observability

| Technology        | Role                                                                                                                                                                                                                                                                                                     |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| OpenTelemetry SDK | Auto-instruments HTTP, gRPC, MongoDB and Redis calls (`tracing.ts`); always exports OTLP over HTTP to `OTEL_EXPORTER_OTLP_ENDPOINT`, default `http://localhost:4318/v1/traces`                                                                                                                           |
| OTel Collector    | Receives OTLP; traces go to Jaeger, metrics to a Prometheus exporter (`infra/otel/otel-collector.yaml`). Decouples the app from backends                                                                                                                                                                 |
| Jaeger            | Trace UI: which store a request hit and where latency lives                                                                                                                                                                                                                                              |
| Prometheus        | Scrapes the backend (`/metrics` on the ops port 9464 of every role), the collector and the Pulsar broker every 15 s; rules in `infra/prometheus/alerts.yml`, routed by Alertmanager                                                                                                                      |
| Grafana           | Dashboards provisioned from `infra/grafana/`, with Prometheus, Jaeger and ClickHouse datasources                                                                                                                                                                                                         |
| Pino              | JSON logs in the OTel log data model behind the logger port, one line per record on stdout, so any log shipper can collect them without an agent in the app. Pretty-printed in development unless `LOG_FORMAT=json`. Fields, event names and redaction: [architecture.md](architecture.md#observability) |

Per-dependency status comes from `GET /api/health`; see
[Degradation behavior](#degradation-behavior).

---

## Quick chooser

| I need to…                                   | Use                                                                          |
| -------------------------------------------- | ---------------------------------------------------------------------------- |
| Cache a query result                         | Redis                                                                        |
| Key/value data larger than a Redis node      | Aerospike (`KV_ADAPTER=aerospike`)                                           |
| Store an order and payment atomically        | PostgreSQL                                                                   |
| Store a flexible document or event log       | MongoDB                                                                      |
| Send an email in the background              | BullMQ                                                                       |
| Wait two days, then run the next step        | Temporal                                                                     |
| Keyword search with typos                    | Elasticsearch                                                                |
| "Find similar" by meaning                    | pgvector                                                                     |
| Tell other services something happened       | Outbox to Pulsar                                                             |
| Aggregate millions of events for a dashboard | ClickHouse (fed by a broker consumer; Flink when one consumer is not enough) |
| Store an uploaded file                       | MinIO                                                                        |
| Fetch a secret or encrypt a field            | Vault                                                                        |
| Decide "can role X do action Y"              | OPA                                                                          |
| Push an update to an open browser            | Socket.io                                                                    |
| Call the backend from the browser            | Connect RPC via `@tropis/sdk`, straight to the backend                       |
| Speed up a profiled CPU-bound hot path       | A Rust service in `services/`                                                |

---

## Degradation behavior

What happens to the running app when each dependency is down.
`GET /api/health` (public role, `modules/health/health.controller.ts`) runs
every probe in `PROBE_KEYS` (`modules/health/health.probes.ts`) in parallel
and names the adapter behind each; `/readyz` runs only the role's required
probes plus the ones that cost no network round trip (`CHEAP_PROBES`), and
answers 503 `starting` until boot has finished. It returns **503** only when a probe the
role requires (`READINESS_PROBES`) is down; a down optional probe is listed in
`degraded` and the response stays 200, and a disabled capability reports up
with `disabled: true`. The route is rate limited and each probe result is shared by every caller,
`/readyz` included, for 3 s, so polling cannot multiply load on the
dependencies; the SMTP handshake runs at most once per 60 s. Both bodies carry
statuses without probe messages, which can name hosts.
Orchestrator probes use `/livez` and `/readyz` on the ops port, with the same
required/optional rule ([architecture.md](architecture.md#observability)).

| Dependency        | When it is down                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Evidence                                                                                                                                                                                                                                                                                                                                                                             |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **MongoDB**       | Hard down. System of record: users, auth, event store and outbox all fail.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | `mongo` probe (`infrastructure/documents/documents.health.ts`)                                                                                                                                                                                                                                                                                                                       |
| **Redis**         | Mixed. Login lockout, the RPC login rate limit, the sign-up rate limits and the HTTP throttlers fail **open**, because a Redis outage must not lock everyone out. The `TokenVerifier` revocation and suspension checks (in `kv`, Redis by default) fail **closed** with `SERVICE_UNAVAILABLE`, so authenticated REST, RPC and WebSocket calls fail. Password login and token refresh fail, because refresh tokens live in `kv`. Cached user reads log and fall through to MongoDB. `Create` with an idempotency key fails (the dedup claim throws). `CreateEvent` returns an error after the event and its outbox row are committed (the stats-cache `del` throws), and `GetStats` fails. The processors cannot take their dedup claim (it runs before the `try`), so each message is redelivered and after the last redelivery parked on `<topic>-DLQ`. The outbox relay cannot take a lease, logs `outbox.relay-lock-unavailable` and stops the poll until Redis returns. Tracking dedup accepts batches as-is. BullMQ queues stall and the scheduler cannot enqueue the sweep. Cross-process realtime pushes are lost. | `auth/services/login-lockout.service.ts`, `auth/services/token-verifier.service.ts`, `infrastructure/cache/cache.client.ts`, `user/commands/create-user.command.ts`, `analytics/services/analytics.service.ts`, `user/processors/user.processor.ts`, `analytics/processors/analytics.processor.ts`, `infrastructure/outbox/outbox.relay.ts`, `tracking/services/tracking.service.ts` |
| **PostgreSQL**    | Only the roles that load the vector capability with `VECTOR_ADAPTER=pgvector` (public, worker) open the pool. Boot waits for it (`POSTGRES_RETRY_ATTEMPTS` x `POSTGRES_RETRY_DELAY`, default 30 x 3 s); after the last attempt TypeORM throws and the role exits. At runtime a failed vector upsert or removal fails the user event, which is redelivered, and `FindSimilar` returns an empty list; the rest of the app is unaffected.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | `infrastructure/relational/adapters/typeorm/typeorm-relational.module.ts`, `user/services/user-similarity.service.ts`                                                                                                                                                                                                                                                                |
| **ClickHouse**    | Reads degrade to empty results (tracking and analytics). Audit inserts log and drop the row. An analytics or tracking insert failure throws, the consumer releases its dedup claim and the message is redelivered, and after the last redelivery parked on `<topic>-DLQ`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | `tracking/repositories/tracking.repository.ts`, `analytics/repositories/analytics.repository.ts`, `audit/services/audit-log.service.ts`                                                                                                                                                                                                                                              |
| **Elasticsearch** | Boot continues with a "search is unavailable" warning; search calls throw to the caller. Index updates in `UserProjectionService` fail the event, which is redelivered and, after the last redelivery, parked on `user-events-DLQ`. Re-indexable from MongoDB.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | `infrastructure/search/adapters/elasticsearch/elasticsearch-search.engine.ts`, `user/processors/user.processor.ts`                                                                                                                                                                                                                                                                   |
| **Pulsar**        | The outbox absorbs it: failed publishes are retried with backoff up to 5 attempts, then marked `dead`, which also holds back later events of that aggregate until an operator redrives or skips it (`make outbox-redrive` / `make outbox-skip`); events arrive late rather than being lost within that budget. Tracking batches are dropped (logged). A consumer that cannot subscribe, or whose subscription stops, resubscribes in the background with backoff (1 s doubling to 30 s), and the worker stays unready (the `consumers` probe) until every consumer runs again.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | `infrastructure/outbox/outbox.relay.ts`, `tracking/services/tracking.service.ts`, `user/processors/user.processor.ts`                                                                                                                                                                                                                                                                |
| **Aerospike**     | Only used with `KV_ADAPTER=aerospike`; then it takes the place of Redis in the `kv` row above. The connection is opened only then. The client is optional, so a missing package or server yields no client and the `kv` probe reports `down`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | `infrastructure/connections/aerospike/`, `infrastructure/kv/adapters/aerospike/`                                                                                                                                                                                                                                                                                                     |
| **Neo4j**         | Off by default (`GRAPH_ADAPTER=disabled`), and then the membership projection does not subscribe. With `neo4j`, a failed projection write redelivers the `user-events` message on the projection's own subscription.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | `features/membership-graph/processors/membership-graph.processor.ts`                                                                                                                                                                                                                                                                                                                 |
| **Vault**         | `VAULT_ADDR` unset logs `vault-disabled` and the `secrets` probe reports `disabled`. Configured but unreachable (or without credentials) at boot: in production the process refuses to start, so it never runs on the schema's development defaults; elsewhere it falls back to `.env`. PostgreSQL falls back to static credentials. A failed AppRole login reports `down` and is retried every 30 s, and a token that cannot be renewed logs in again, so the adapter recovers once Vault is back. Vault requests time out after 5 s.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | `infrastructure/secrets/adapters/vault/vault-env-loader.ts`, `vault-secrets.adapter.ts`, `user/services/user.service.ts`                                                                                                                                                                                                                                                             |
| **OPA**           | **Fails closed, as unavailable**: unreachable, non-2xx or open circuit logs a warning and every authorization-gated call fails with `SERVICE_UNAVAILABLE` (503, retryable), never a permission denial, until OPA answers again.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | `infrastructure/policy/adapters/opa/opa-policy.adapter.ts`                                                                                                                                                                                                                                                                                                                           |
| **MinIO**         | Boot continues with a "file storage is unavailable" warning; upload and URL calls throw to the caller.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | `infrastructure/objects/adapters/minio/minio-objects.adapter.ts`                                                                                                                                                                                                                                                                                                                     |
| **Temporal**      | Unreachable at boot: the app boots, the worker role's Temporal worker retries its start with backoff (5 s doubling to 60 s) and restarts the same way when its run fails, `GET /api/workflows/onboarding` returns an empty summary with `available: false`, onboarding workflows are not started, and the `workflow` probe fails. The client reconnects on demand, at most once per 10 s with one attempt shared by concurrent callers, so a Temporal that comes back is used without a restart. Lost after a connection: the onboarding endpoint errors, and workflow starts fail with a logged warning and are not retried.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | `infrastructure/workflow/adapters/temporal/temporal-client.holder.ts`, `temporal-worker.service.ts`, `modules/workflows/workflows.controller.ts`, `user/processors/user.processor.ts`                                                                                                                                                                                                |
| **SMTP**          | `NotificationService.sendEmail()` rejects, so the BullMQ job is retried and then dead-lettered, and the Temporal activity is retried by the engine. A 4xx `AppError` (for example a message without a single bare recipient, `VALIDATION_FAILED`) is permanent: it fails at once (BullMQ `UnrecoverableError`, Temporal non-retryable). The `mail` probe (`transport.verify()`, at most once per 60 s) fails.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | `notification/services/notification.service.ts`, `infrastructure/mail/adapters/smtp/smtp-mail.adapter.ts`, `infrastructure/capability/permanent-failure.ts`                                                                                                                                                                                                                          |

## Vendor swap matrix

Each infrastructure choice sits behind a standard protocol or an in-code port;
that decides the cost of swapping vendors.

| Vendor                                                              | Standard interface                                                                                                     | Swap to                                              | Cost of swapping                                                                                                                                                               |
| ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Jaeger (traces)                                                     | **OTLP** via the OTel Collector                                                                                        | Tempo, Zipkin, Datadog, any OTLP sink                | **Config change**: the collector exporter in `infra/otel/`; app untouched                                                                                                      |
| Prometheus (metrics)                                                | **Prometheus exposition format** (`:9464/metrics`)                                                                     | VictoriaMetrics, Mimir, Grafana Cloud, any scraper   | **Config change**: point the scraper at the same endpoint                                                                                                                      |
| MinIO (objects, local only)                                         | **S3 API**                                                                                                             | AWS S3, GCS (S3 mode), Ceph, R2                      | **Env change**: `MINIO_*` endpoint and keys; same client                                                                                                                       |
| Mailpit (email)                                                     | **SMTP**                                                                                                               | SES, Postmark, any SMTP relay                        | **Env change**: `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`                                                                                                             |
| Pulsar (events)                                                     | **`MessagingPort`** (`infrastructure/messaging/`)                                                                      | Kafka (adapter included), any broker with an adapter | **Env change** to Kafka (`MESSAGING_ADAPTER=kafka`); another broker is **one adapter** implementing the port and passing its conformance suite; outbox and consumers unchanged |
| Pino stdout logs                                                    | **JSON lines on stdout**                                                                                               | Loki, ELK, CloudWatch, any log shipper               | **Config change**: ship stdout differently; app untouched                                                                                                                      |
| Vault (secrets)                                                     | **`SecretsPort`** (`infrastructure/secrets/`)                                                                          | AWS / GCP Secret Manager, plain `.env`               | **Env change** to `SECRETS_ADAPTER=env`; in Kubernetes swap the External Secrets `SecretStore`. Dynamic DB credentials need another adapter                                    |
| PostgreSQL / ClickHouse / Elasticsearch / Redis / Aerospike / Neo4j | **Capability ports** (`RELATIONAL`, `VECTOR`, `OLAP`, `SEARCH`, `CACHE`, `KV`, `LOCK`, `RATE_LIMIT`, `DEDUP`, `GRAPH`) | Managed same-engine offerings, or another engine     | **Managed same engine = env change.** A different engine is one adapter passing the capability's conformance suite (`__tests__/*.conformance.ts`); business code unchanged     |
| MongoDB                                                             | Mongoose models in each module's repositories                                                                          | Managed MongoDB offerings                            | **Managed same engine = env change.** Repositories are the documents adapter layer, so a different document engine means rewriting them; a deliberate deep dependency          |

---

## Frontend

Two frontends with different jobs: `helm` is the logged-in console
(client-rendered SPA kept out of search indexes by `public/robots.txt`
`Disallow: /`, with `<Seo … noindex />` set only on `AnalyticsPage`; also
wrapped by the mobile and desktop shells)
and `harbor` is the public marketing and content site (Next.js 15 App Router,
SSR/SSG with `robots.ts` and `sitemap.ts`). Why they are split and the quality
bars: [web-quality.md](web-quality.md). Paths below are relative to
`apps/frontend/helm/`.

### shadcn/ui (UI primitives)

A copy-in component library, not an npm dependency. The primitives in
`src/components/ui/` are owned source built on Radix (keyboard, focus and ARIA
for dialogs, menus and selects) and styled with the app's Tailwind v4 tokens:
`src/index.css` exposes shadcn-compatible aliases (`--color-muted-foreground`,
`--color-accent`, …) that point at the existing palette, so there is no second
theme. Toasts stay on the Zustand `toastStore` + `Toasts.tsx`, because they are
wired into the WebSocket handlers and mutations and a second toast library
would add a parallel store.

### react-hook-form + zod (forms)

Each form declares a zod schema as the single source of validation truth, the
frontend mirror of the backend DTO validation; react-hook-form handles
registration, submit state and per-field errors without re-rendering the whole
form on each keystroke. `useZodForm` (`src/lib/forms.ts`) wires the resolver;
errors render inline with `aria-invalid` and `aria-describedby`. Reference:
`src/features/auth/components/LoginForm.tsx`.

### react-i18next (i18n)

`src/lib/i18n.ts` bundles resources statically (`src/locales/{en,zh}/common.json`):
two small files do not justify an async loading layer.
English is the default and fallback; detection order is localStorage, then
`navigator.language`, and the language switcher persists the choice through
the detector's localStorage cache. Keys are grouped by feature (`common`,
`nav`, `theme`, `toasts`, `analytics`, `auth`, `users`, `stack`, `behavior`).
Two contracts:

1. The e2e suite selects by visible English text, so strings in `en/common.json` used by the repo-root `e2e/tests/*.spec.ts` change only together with the specs.
2. zod messages are translated by building each schema with `t` (`makeSchema(..., t)`), not a global zod error map, so messages stay next to the schema.

`<html lang>` follows the active language through a `languageChanged` listener.

### Frontend capability map

| Concern           | Solution                                                                                                                                                                           | Outgrown when, and what to reach for                                                                                  |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Client state      | Local `useState`, Zustand, TanStack Query; placement and defaults: [project-structure.md](project-structure.md#state-management)                                                   | Interdependent store logic: Zustand slices or middleware before any other state library                               |
| Server cache      | TanStack Query with optimistic updates; defaults: [project-structure.md](project-structure.md#state-management)                                                                    | Long lists: `useInfiniteQuery`; realtime-heavy views: invalidate from WebSocket events                                |
| Styling           | Tailwind v4 + design tokens in `src/index.css`                                                                                                                                     | Tokens are the theme contract; no CSS-in-JS                                                                           |
| Component library | shadcn/ui, owned code in `src/components/ui/` on Radix                                                                                                                             | Copy more primitives from shadcn; do not switch to an npm UI kit                                                      |
| Forms             | react-hook-form + zod via `useZodForm`                                                                                                                                             | Multi-step wizards: RHF `FormProvider`; shared schemas via `@tropis/shared`                                           |
| i18n              | react-i18next, en (default) + zh, bundled JSON, feature-grouped keys                                                                                                               | More than five locales or heavy content: lazy-loaded namespaces; ICU only when plural or gender rules demand it       |
| Theming           | Class-based dark mode (`html.dark`), pre-paint script in `index.html`, `ThemeProvider` (light / dark / system)                                                                     | More themes: extend tokens in `src/index.css`, not per-component styles                                               |
| Routing           | React Router 7, route-level `lazy()` code splitting (`src/app/App.tsx`)                                                                                                            | Data-heavy routes: router loaders. File-based routing is not worth a migration while lazy routes cover code splitting |
| Realtime          | socket.io client inside `@tropis/sdk`, adapted by `src/lib/websocket.ts`, for domain events and the live analytics feed                                                            | Fan-out growth is a server concern (rooms, namespaces); the client stays as is                                        |
| Tracking          | `@tropis/sdk` tracker to `POST /api/v1/track` (see [Tracking](#tracking-user-behavior-instrumentation))                                                                            | New events are registered in [tracking-plan.md](tracking-plan.md) first                                               |
| PWA / offline     | vite-plugin-pwa `autoUpdate`, precached app shell                                                                                                                                  | A real offline-data requirement: TanStack Query persister + Workbox runtime caching                                   |
| a11y              | eslint-plugin-jsx-a11y in CI lint, skip link, `aria-invalid` / `aria-describedby` form pattern, `<html lang>` sync                                                                 | Ship-blocking audits: axe-core in the Playwright suite                                                                |
| Charts            | recharts (`src/features/analytics/components/`)                                                                                                                                    | Beyond roughly 10k points or 60 fps streams: a canvas renderer (visx, uPlot)                                          |
| Images            | `loading="lazy"`, explicit dimensions and `alt` ([project-structure.md](project-structure.md)); originals from MinIO                                                               | Images rendered above 32 px: add `srcset`                                                                             |
| Virtualization    | None; the largest list is the 30-row live feed                                                                                                                                     | Lists beyond roughly 500 rows: `@tanstack/react-virtual`                                                              |
| 2D/3D graphics    | Out of scope: helm has no canvas or WebGL                                                                                                                                          | If needed: pixi.js (2D) or three.js (3D) as an isolated feature                                                       |
| Client shells     | The PWA is the default channel. Capacitor (`capacitor.config.ts`, `android/`, `ios/`) wraps the web build for the app stores; Tauri v2 (`apps/desktop/`) builds desktop installers | Build, signing and distribution: [deployment.md](deployment.md#native-distribution)                                   |

### Channel choice

The PWA is the default channel because one web build covers Android install,
iOS Add to Home Screen and desktop Chrome / Edge install with no store review.
Capacitor is for store presence or native APIs the web platform does not
expose. Tauri is for desktop installers, because its binaries are small
compared with Electron's: it uses the system webview instead of bundling
Chromium. Build steps: [deployment.md](deployment.md#native-distribution).

All shells reuse the same web build; the business logic lives in
`@tropis/sdk` and `src/state/`, so each shell swaps only the container.
