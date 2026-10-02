# Development

Everything needed to work on the foundation locally: setup, daily commands, the
container stack, how to poke each service, environment variables, local setup
tasks and troubleshooting. How the pieces fit together is in
[architecture.md](architecture.md); why each technology exists is in
[tech-decisions.md](tech-decisions.md); tests are in [testing.md](testing.md);
production, Kubernetes and native builds are in [deployment.md](deployment.md).

- [Setup](#setup)
- [Daily commands](#daily-commands)
- [Compose profiles](#compose-profiles)
- [Port map](#port-map)
- [Dev tools](#dev-tools)
- [Service reference](#service-reference)
- [Environment variables](#environment-variables)
- [Local setup tasks](#local-setup-tasks)
- [Troubleshooting](#troubleshooting)

## Setup

### Prerequisites

| Tool                   | Version                                                   | Install / notes                                                                        |
| ---------------------- | --------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Docker Desktop         | recent, **8 GB+** memory allocated (Settings → Resources) | Docker Compose v2 (`docker compose`) is required                                       |
| Node.js                | **≥ 22** (`.nvmrc` pins 22)                               | `nvm install 22 && nvm use`                                                            |
| pnpm                   | 10 (`packageManager` pins `pnpm@10.33.0`)                 | `corepack enable`                                                                      |
| Rust (optional)        | stable                                                    | [rustup.rs](https://rustup.rs) — only for `services/rust/signing/` and `apps/desktop/` |
| Android Studio / Xcode | —                                                         | only for the mobile shells — see [deployment.md](deployment.md) for native builds      |

### First run

```bash
git clone <this-repo> && cd <repo>
nvm use                                        # Node 22 from .nvmrc
make install                                   # pnpm install + creates apps/backend/.env and apps/frontend/helm/.env from the examples
make up                                        # core + every profile the backend needs (first run pulls images)
make migrate                                   # PostgreSQL schema (vector_embeddings); until it runs, `vector` reports down
make dev                                       # backend, every role in one process (:3100 REST/WS, :50051/:50061 RPC, :9464 ops) + helm (:5173), watch mode
# second terminal, once the backend is up:
make seed                                      # tenant dev + admin@example.com (admin) + 20 demo users (role: member) + ~50 analytics events
```

**Success check:** open http://localhost:5173, log in with `admin@example.com` /
`Password123!`, and the Analytics dashboard loads; the Users page lists the
seeded users. `curl -s http://localhost:9464/readyz` and
`http://localhost:3100/api/health` (every capability, with the adapter in use)
return 200 once the dependencies the role requires are up (under `make dev`:
`documents`, `cache`, `kv`, `ratelimit`, `lock`, `dedup`, `policy`, `messaging`,
`jobs`); any other
capability that is still down is listed in `degraded`. Pulsar and
Elasticsearch are the slowest to start. If something fails, see [Troubleshooting](#troubleshooting).

What runs where:

- `make dev` (= `pnpm dev`) runs the backend (`nest start --watch`, entry
  `src/main.ts`: the `all` role, so public, private, worker and scheduler run in
  one process) and **helm** (the console, `vite`), together. Deployments run
  each role as its own process ([architecture.md](architecture.md#backend-roles));
  to run one locally, `pnpm --filter @tropis/backend build` and then
  `pnpm --filter @tropis/backend start:<role>` (give each its own `OPS_PORT`
  when running several).
- **harbor**, the public Next.js site, is not part of `pnpm dev`:
  `pnpm --filter @tropis/harbor dev` → http://localhost:4000.
- ClickHouse tables, the MongoDB replica set, Vault secrets and the MinIO bucket
  are created automatically (init scripts, one-shot containers and backend
  startup). Nothing else is required for login and the users page.

Next: [architecture.md](architecture.md) (what you just started),
[project-structure.md](project-structure.md) (where code goes).

## Daily commands

### Make targets

`make help` lists every target. `COMPOSE` below means
`docker compose -f infra/docker/docker-compose.yml`.

| Target                                                                                 | What it does                                                                                                                                                                                                                             |
| -------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `make install`                                                                         | `pnpm install` + create `apps/backend/.env` and `apps/frontend/helm/.env` if missing                                                                                                                                                     |
| `make dev`                                                                             | backend + helm in watch mode (`pnpm dev`)                                                                                                                                                                                                |
| `make up`                                                                              | core + every profile the backend requires (`relational`, `search`, `olap`, `objects`, `workflow`, `secrets`, `kv-scale`)                                                                                                                 |
| `make up-core`                                                                         | core only (`mongodb`, `redis`, `pulsar`, `opa`, `mailpit`); the backend does not boot on it alone                                                                                                                                        |
| `make up-graph` / `up-kafka` / `up-stream` / `up-signing` / `up-obs`                   | core + that profile (`up-signing` builds the image)                                                                                                                                                                                      |
| `make up-tools`                                                                        | the `make up` stack + `tools`                                                                                                                                                                                                            |
| `make up-all`                                                                          | every profile                                                                                                                                                                                                                            |
| `make down`                                                                            | stop and remove the containers of every profile                                                                                                                                                                                          |
| `make logs [SERVICE=<name>]`                                                           | follow compose logs (all services, or one)                                                                                                                                                                                               |
| `make seed`                                                                            | register tenant `dev` (self sign-up on), sign up `admin@example.com` and grant it admin in MongoDB, then as that admin create 20 demo users and ~50 analytics events through the running backend (RPC)                                   |
| `make promote-admin EMAIL=<email>`                                                     | grant `admin` directly in MongoDB (tenant `TENANT_ID`, `dev` when unset); effective within 5 min (member profile cache)                                                                                                                  |
| `make tenant-create ID=<id> NAME=<name> [SELF_SIGNUP=true] [STATUS=active\|suspended]` | register or update a tenant directly in MongoDB — see [Adding a tenant](#adding-a-tenant)                                                                                                                                                |
| `make migrate`                                                                         | PostgreSQL migrations up — see [PostgreSQL migrations](#postgresql-migrations)                                                                                                                                                           |
| `make test` / `test-int` / `test-e2e`                                                  | unit / integration / full-stack E2E — see [testing.md](testing.md)                                                                                                                                                                       |
| `make load-test`                                                                       | k6 scenarios in Docker against `localhost:3100` — see [testing.md](testing.md)                                                                                                                                                           |
| `make lint` / `make build`                                                             | `pnpm -r lint` / `pnpm -r build`                                                                                                                                                                                                         |
| `make proto`                                                                           | regenerate the protobuf + Connect types (`buf generate` → `packages/sdk/src/gen` and `apps/backend/src/gen`) with the buf version pinned in `packages/sdk` (the one CI runs)                                                             |
| `make backup` / `make restore TS=<ts>`                                                 | dump / restore MongoDB + PostgreSQL + ClickHouse under `./backups/` (restore is destructive)                                                                                                                                             |
| `make rust-build` / `make rust-test`                                                   | build / fmt + clippy + test the Cargo workspace at the repo root (`services/rust/signing`)                                                                                                                                               |
| `make android` / `make desktop`                                                        | Capacitor Android sync / Tauri desktop bundle — see [deployment.md](deployment.md)                                                                                                                                                       |
| `make k8s` / `make k8s-ui`                                                             | k9s / Headlamp for the local `kind-tropis` cluster — see [deployment.md](deployment.md)                                                                                                                                                  |
| Dev-tool targets                                                                       | `pulsar-tail`, `pulsar-send`, `ws-listen`, `outbox-status`, `outbox-dead`, `outbox-redrive`, `outbox-skip`, `jobs-dlq`, `jobs-dlq-replay`, `messaging-dlq`, `messaging-dlq-redrive`, `sdk-repl`, `wf-demo` — see [Dev tools](#dev-tools) |

### Root pnpm scripts

```bash
pnpm dev          # backend + helm (same as make dev)
pnpm backend      # backend only (all roles) → http://localhost:3100/api
pnpm frontend     # helm only     → http://localhost:5173
pnpm build        # pnpm -r build
pnpm test         # pnpm -r test (Jest in the backend, Vitest in the frontends)
pnpm lint         # pnpm -r lint
pnpm docker:up    # docker compose up -d (core)
pnpm docker:down  # docker compose down
pnpm docker:logs  # docker compose logs -f
pnpm docker:ps    # docker compose ps
```

Stop dev servers with `Ctrl+C`, not `Ctrl+Z`: `Ctrl+Z` suspends the process and
it keeps holding its port.

## Compose profiles

Services without a profile are **core**: what the foundation needs to
authenticate a user and publish an event. Every other capability sits behind a
profile named after its responsibility. `make up` starts core plus every
profile the backend currently requires (`BACKEND_PROFILES` in the `Makefile`),
which is enough for `make dev`, login and the users page. A plain
`docker compose up -d` (`make up-core`, `pnpm docker:up`) starts core only, and
the backend does not boot on core alone.

| Profile         | Start with        | Services (compose service names)                                                                                                       |
| --------------- | ----------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| _(core)_        | `make up-core`    | `mongodb`, `mongo-rs-reconfig` (one-shot), `redis`, `pulsar`, `opa`, `mailpit`                                                         |
| `relational`    | `make up`         | `postgres`                                                                                                                             |
| `search`        | `make up`         | `elasticsearch`                                                                                                                        |
| `olap`          | `make up`         | `clickhouse`                                                                                                                           |
| `objects`       | `make up`         | `minio`                                                                                                                                |
| `workflow`      | `make up`         | `temporal`, `postgresql-temporal`                                                                                                      |
| `secrets`       | `make up`         | `vault`, `vault-init` (one-shot)                                                                                                       |
| `kv-scale`      | `make up`         | `aerospike`                                                                                                                            |
| `graph`         | `make up-graph`   | `neo4j`; the backend uses it with `GRAPH_ADAPTER=neo4j` (membership projection)                                                        |
| `kafka`         | `make up-kafka`   | `kafka`                                                                                                                                |
| `stream`        | `make up-stream`  | `flink-jobmanager`, `flink-taskmanager`; the job owns OLAP writes only with `STREAM_ENGINE=flink` ([Flink](#flink))                    |
| `signing`       | `make up-signing` | `signing` (Rust gRPC HMAC service, `tropis.signing.v1`) — see [services/rust/signing/README.md](../services/rust/signing/README.md)    |
| `observability` | `make up-obs`     | `otel-collector`, `jaeger`, `prometheus`, `alertmanager`, `grafana`                                                                    |
| `tools`         | `make up-tools`   | `grpcui`, `pulsar-manager`, `redisinsight`, `mongo-express`, `pgadmin`, `kibana`, `clickhouse-ui`, `metabase`, `temporal-ui`, `dozzle` |

- `make up-all` enables every profile.
- Images are pinned to explicit versions (only the `tools` UIs follow
  `latest`), so a fresh clone runs what the repo was tested with. MinIO uses
  `pgsty/minio`, a source rebuild, because official MinIO images are not
  published; it is a local and test stand-in only, production object storage is
  managed S3 ([deployment.md](deployment.md)).
- Datastores and engines carry healthchecks, and services that need another
  one wait for it (`depends_on` with `condition: service_healthy`).
  `docker compose ... up -d --wait <services>` blocks until they are healthy;
  leave out the one-shot `mongo-rs-reconfig` and `vault-init`, which exit
  when done and which `--wait` reports as failures (`make test-e2e` does this).
- One profiled service on its own:
  `docker compose -f infra/docker/docker-compose.yml --profile tools up -d kibana`.
- List a profile's services:
  `docker compose -f infra/docker/docker-compose.yml --profile <name> config --services`.
- Background reading per technology: [tech-decisions.md](tech-decisions.md);
  the tracing and metrics pipeline: [architecture.md](architecture.md#observability).

## Port map

Host ports as published by `infra/docker/docker-compose.yml` and the app
defaults. "Profile" is blank for core services and the app itself. Every
Compose port binds to `127.0.0.1` only: the datastores run without
authentication and Vault and OPA with fixed dev tokens, so nothing is
reachable from the network.

| Service                     | Host port        | Profile         | URL / notes                                                                                                                                                        |
| --------------------------- | ---------------- | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| helm (Vite dev server)      | 5173             |                 | http://localhost:5173                                                                                                                                              |
| harbor (Next.js dev/start)  | 4000             |                 | http://localhost:4000                                                                                                                                              |
| Backend HTTP                | 3100             |                 | http://localhost:3100/api                                                                                                                                          |
| Backend WebSocket           | 3100             |                 | Socket.io namespace `/ws` on the HTTP port                                                                                                                         |
| Swagger UI                  | 3100             |                 | http://localhost:3100/api/docs (not mounted when `NODE_ENV=production`)                                                                                            |
| Backend ops port            | 9464             |                 | `/livez`, `/readyz` (503 until boot finishes, while a dependency the role requires is down, and during shutdown), `/metrics` (Prometheus); every role (`OPS_PORT`) |
| Bull Board                  | 3100             |                 | http://localhost:3100/api/queues (`make dev` only: the `all` role, outside production, from localhost)                                                             |
| Backend RPC (public tier)   | 50051            |                 | `tropis.<domain>.v1` over Connect, gRPC and gRPC-Web; helm and grpcui target it                                                                                    |
| Backend RPC (internal tier) | 50061            |                 | `tropis.<domain>.internal.v1`; needs `SERVICE_TOKEN` — see [api-conventions.md](api-conventions.md)                                                                |
| Signing (Rust gRPC)         | 50052            | `signing`       | `tropis.signing.v1`                                                                                                                                                |
| Neo4j Browser / Bolt        | 7474 / 7687      | `graph`         | http://localhost:7474 — used with `GRAPH_ADAPTER=neo4j`                                                                                                            |
| Kafka                       | 9092             | `kafka`         | single-node KRaft; used with `MESSAGING_ADAPTER=kafka`                                                                                                             |
| MongoDB                     | 27018            |                 | container port 27017 (`27018:27017`)                                                                                                                               |
| PostgreSQL (pgvector)       | 5432             | `relational`    | user `tropis`, password `tropis_dev_password`, db `tropis`                                                                                                         |
| Redis                       | 6379             |                 | also backs BullMQ                                                                                                                                                  |
| ClickHouse HTTP / native    | 8123 / 9000      | `olap`          | user `default`, database `logs`                                                                                                                                    |
| Aerospike                   | 3000, 3001, 3003 | `kv-scale`      | client / fabric / info                                                                                                                                             |
| Pulsar binary / HTTP admin  | 6650 / 8080      |                 | admin port also serves broker metrics                                                                                                                              |
| Elasticsearch               | 9200             | `search`        | security disabled                                                                                                                                                  |
| MinIO S3 API / Console      | 9900 / 9902      | `objects`       | http://localhost:9902 — `minioadmin` / `minioadmin123`                                                                                                             |
| Mailpit SMTP / Web UI       | 1025 / 8025      |                 | http://localhost:8025                                                                                                                                              |
| OPA                         | 8181             |                 | http://localhost:8181 — policy query API                                                                                                                           |
| Vault                       | 8200             | `secrets`       | http://localhost:8200 — dev root token `dev-root-token`                                                                                                            |
| Temporal gRPC               | 7233             | `workflow`      | the backend's client and in-process worker connect here                                                                                                            |
| Flink Web UI                | 8081             | `stream`        | http://localhost:8081                                                                                                                                              |
| OTel Collector gRPC / HTTP  | 4317 / 4318      | `observability` | the backend sends traces to `:4318/v1/traces`                                                                                                                      |
| OTel Collector metrics      | 8888 / 8889      | `observability` | self-metrics / exported app metrics (Prometheus scrapes both in-network)                                                                                           |
| Jaeger UI / collector gRPC  | 16686 / 14250    | `observability` | http://localhost:16686                                                                                                                                             |
| Prometheus                  | 9090             | `observability` | http://localhost:9090                                                                                                                                              |
| Alertmanager                | 9093             | `observability` | http://localhost:9093                                                                                                                                              |
| Grafana                     | 3101             | `observability` | http://localhost:3101 — `admin` / `admin` (container 3000; host 3000 is Aerospike)                                                                                 |
| grpcui                      | 8083             | `tools`         | http://localhost:8083                                                                                                                                              |
| Pulsar Manager UI / API     | 9527 / 7750      | `tools`         | http://localhost:9527                                                                                                                                              |
| RedisInsight                | 5540             | `tools`         | http://localhost:5540                                                                                                                                              |
| mongo-express               | 8085             | `tools`         | http://localhost:8085 — no basic auth                                                                                                                              |
| pgAdmin                     | 5050             | `tools`         | http://localhost:5050 — desktop mode, no login                                                                                                                     |
| Kibana                      | 5601             | `tools`         | http://localhost:5601                                                                                                                                              |
| CH-UI                       | 8124             | `tools`         | http://localhost:8124 — connect to `http://localhost:8123`, user `default`                                                                                         |
| Metabase                    | 3200             | `tools`         | http://localhost:3200 — BI over ClickHouse                                                                                                                         |
| Temporal Web UI             | 8233             | `tools`         | http://localhost:8233                                                                                                                                              |
| Dozzle                      | 9999             | `tools`         | http://localhost:9999 — live container logs                                                                                                                        |

BullMQ and WebSockets need no extra containers: BullMQ uses Redis on 6379 and
Socket.io runs on the backend's HTTP server. Temporal uses two `workflow`
containers: `temporal` (server) and `postgresql-temporal` (its own Postgres, no host port);
its web UI (`temporal-ui`) is in `tools`.

## Dev tools

Technology → tool → how to open it. Each tool's own UI explains the rest.
Custom CLI tools live in `devtools/` — see [devtools/README.md](../devtools/README.md)
for how to add one.

| Technology          | Tool                     | How                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ------------------- | ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| REST API            | Swagger UI               | `make dev` → http://localhost:3100/api/docs                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| gRPC                | grpcui                   | `make dev`, then `make up-tools` → http://localhost:8083                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| gRPC                | grpcurl / Postman        | `grpcurl -plaintext localhost:50051 list` (Postman: enable "server reflection") — see [gRPC](#grpc)                                                                                                                                                                                                                                                                                                                                                                                      |
| Pulsar (browse)     | Pulsar Manager           | `make up-tools` → http://localhost:9527 — see [Pulsar](#pulsar)                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Pulsar (tail/send)  | pulsar-client CLI        | `make pulsar-tail TOPIC=user-events` · `make pulsar-send TOPIC=user-events MSG='{"a":1}'`                                                                                                                                                                                                                                                                                                                                                                                                |
| WebSocket (`/ws`)   | ws-listen (devtools)     | `make ws-listen [TOKEN=<jwt>]` — prints every Socket.io event; without `TOKEN` it logs in as `admin@example.com`                                                                                                                                                                                                                                                                                                                                                                         |
| Outbox              | outbox-status (devtools) | `make outbox-status` — counts by status + oldest open rows, straight from MongoDB                                                                                                                                                                                                                                                                                                                                                                                                        |
| Outbox DEAD rows    | outbox-dead (devtools)   | `make outbox-dead` lists them; `make outbox-redrive ID=<row id>` / `make outbox-skip ID=<row id>` (or `AGGREGATE=<id>`) release the aggregate                                                                                                                                                                                                                                                                                                                                            |
| BullMQ DLQ          | jobs-dlq (devtools)      | `make jobs-dlq` lists dead-lettered jobs; `make jobs-dlq-replay ID=<dlq job id>` retries the source job and removes the entry                                                                                                                                                                                                                                                                                                                                                            |
| Pulsar DLQ          | messaging-dlq (devtools) | `make messaging-dlq TOPIC=<topic> SUB=<subscription>` lists the messages kept on `<topic>-DLQ` by subscription `<subscription>-DLQ`; `make messaging-dlq-redrive TOPIC=<topic> SUB=<subscription> [COUNT=n]` republishes the oldest `n` (default 1) to `<topic>` with their properties and key, then drops them from the DLQ. Consumers dedup on the event id, so redriving an event that was handled changes nothing. Pulsar only (`PULSAR_ADMIN_URL`, default `http://localhost:8080`) |
| SDK (`@tropis/sdk`) | REPL (devtools)          | `make sdk-repl` — `api` facade preloaded and logged in as `admin@example.com` (admin after `make seed`), so `await api.fetchUsers()` works                                                                                                                                                                                                                                                                                                                                               |
| Temporal            | Temporal Web UI          | `make up-tools` → http://localhost:8233 · `make wf-demo` — see [Temporal](#temporal)                                                                                                                                                                                                                                                                                                                                                                                                     |
| Flink               | Flink Web UI             | `make up-stream` → http://localhost:8081                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Email               | Mailpit                  | `make up` → http://localhost:8025                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Redis               | RedisInsight             | `make up-tools` → http://localhost:5540                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| MongoDB             | mongo-express            | `make up-tools` → http://localhost:8085                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ClickHouse          | CH-UI / Metabase         | `make up-tools` → http://localhost:8124 (CH-UI) · http://localhost:3200 (Metabase)                                                                                                                                                                                                                                                                                                                                                                                                       |
| Elasticsearch       | Kibana                   | `make up-tools` → http://localhost:5601                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| PostgreSQL          | pgAdmin                  | `make up-tools` → http://localhost:5050                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Object storage      | MinIO Console            | `make up` → http://localhost:9902 (`minioadmin` / `minioadmin123`)                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Secrets             | Vault UI                 | `make up` → http://localhost:8200 (token `dev-root-token`)                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Policy (authz)      | OPA REST API             | `make up` → http://localhost:8181 — see [OPA](#opa)                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Tracing             | Jaeger                   | `make up-obs` → http://localhost:16686                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Metrics             | Prometheus / Grafana     | `make up-obs` → http://localhost:9090 · http://localhost:3101                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Alerting            | Alertmanager             | `make up-obs` → http://localhost:9093                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Containers / logs   | Dozzle                   | `make up-tools` → http://localhost:9999                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| BullMQ queues + DLQ | Bull Board               | `make dev` → http://localhost:3100/api/queues — inspect and retry jobs, inspect `dead-letter` jobs (replay them with `make jobs-dlq-replay`)                                                                                                                                                                                                                                                                                                                                             |
| Load testing        | k6                       | `make load-test` (stack up + seeded — see [load/README.md](../load/README.md))                                                                                                                                                                                                                                                                                                                                                                                                           |
| Admin role          | promote-admin script     | `make promote-admin EMAIL=<email>` (effective within 5 min)                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Tenants             | tenant-create script     | `make tenant-create ID=<id> NAME=<name> [SELF_SIGNUP=true]` — see [Adding a tenant](#adding-a-tenant)                                                                                                                                                                                                                                                                                                                                                                                    |
| Local Kubernetes    | k9s / Headlamp           | `make k8s` / `make k8s-ui` (needs the `kind-tropis` cluster — see [deployment.md](deployment.md))                                                                                                                                                                                                                                                                                                                                                                                        |

**gRPC reflection** powers grpcui, grpcurl and Postman discovery without proto
files. It is on whenever `NODE_ENV` is not `production`; in production it is off
unless `GRPC_REFLECTION=true`. Both listeners (:50051 and :50061) share the gate
because reflection reveals the whole schema (`apps/backend/src/config/grpc-reflection.ts`).

The `grpcui` container targets the backend on the host
(`host.docker.internal:50051`): start the backend before bringing up `tools`, or
restart the container afterwards
(`docker compose -f infra/docker/docker-compose.yml restart grpcui`).

## Service reference

Containers are named `tropis_<service>` with hyphens turned into underscores
(`mongo-rs-reconfig` → `tropis_mongo_rs_reconfig`). The exceptions are
`tropis_otel` (`otel-collector`), `tropis_flink_jm` / `tropis_flink_tm`
(`flink-jobmanager` / `flink-taskmanager`) and `tropis_temporal_postgres`
(`postgresql-temporal`). `docker ps` shows them all.

### Docker

```bash
# Start / stop
docker compose -f infra/docker/docker-compose.yml up -d                     # core
docker compose -f infra/docker/docker-compose.yml restart <service>
make down                                                                   # every profile
docker compose -f infra/docker/docker-compose.yml --profile signing down    # the signing container
docker compose -f infra/docker/docker-compose.yml --profile '*' down -v     # every profile, and wipe all volumes

# Status and logs
docker compose -f infra/docker/docker-compose.yml ps
docker logs -f tropis_pulsar            # follow
docker logs --tail 50 tropis_pulsar     # last 50 lines

# Individual services
docker compose -f infra/docker/docker-compose.yml up -d mongodb redis clickhouse postgres elasticsearch
docker compose -f infra/docker/docker-compose.yml stop pulsar
docker compose -f infra/docker/docker-compose.yml rm -f pulsar && \
  docker compose -f infra/docker/docker-compose.yml up -d pulsar        # recreate fresh
```

### Processes and ports

```bash
ps aux | grep node
lsof -i :3100                                                     # who owns a port
kill -9 $(lsof -ti :3100 -ti :50051 -ti :50061 -ti :9464 -ti :5173) 2>/dev/null   # free the dev ports
```

### Pulsar

```bash
make pulsar-tail TOPIC=user-events                       # tail a topic live (Ctrl-C to stop)
make pulsar-send TOPIC=user-events MSG='{"hello":"world"}'
```

Pulsar Manager (`tools`) needs an admin account on first use:

```bash
CSRF_TOKEN=$(curl -s http://localhost:7750/pulsar-manager/csrf-token)
curl -X PUT http://localhost:7750/pulsar-manager/users/superuser \
  -H "X-XSRF-TOKEN: $CSRF_TOKEN" \
  -H "Cookie: XSRF-TOKEN=$CSRF_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"admin","password":"admin123","description":"admin","email":"admin@local.dev"}'
```

Then log in at http://localhost:9527 with `admin` / `admin123` and add an
environment with Service URL `http://pulsar:8080` (the compose service name —
Pulsar Manager runs inside the Docker network).

### Redis

Every cache, kv, lock, ratelimit and dedup key follows the keyspace
`{app}:{env}:{t.<tenantId>|global}:{capability}:{module}:{name}:{version}[:id]`
(`KEYSPACE_APP` / `KEYSPACE_ENV`), built only by `defineKey()` in the owning
module's `constants/` (rules: `apps/backend/src/common/keyspace/keyspace.ts`).

```bash
docker exec -it tropis_redis redis-cli                                                   # interactive shell
docker exec -it tropis_redis redis-cli --scan --pattern 'tropis:development:t.dev:*'      # every key of tenant dev
docker exec -it tropis_redis redis-cli GET 'tropis:development:t.dev:cache:user:profile:v1:<userId>'   # cached user (300s TTL)
docker exec -it tropis_redis redis-cli --scan --pattern 'bull:*'                          # BullMQ keys
```

**RedisInsight** (http://localhost:5540, `tools`): "Add Redis Database" with host
`redis`, port `6379` — the Docker service name, because RedisInsight runs in the
Docker network.

### PostgreSQL

```bash
docker exec -it tropis_postgres psql -U tropis -d tropis
```

The vector capability stores embeddings in `vector_embeddings` (384
dimensions, keyed by `tenant_id, collection, id`, under tenant row-level
security); the user module writes collection `user-profile`. `psql` as the
`tropis` superuser bypasses row-level security, so filter by tenant yourself:

```sql
SELECT id, embedding <=> (SELECT embedding FROM vector_embeddings
                          WHERE tenant_id = 'dev' AND collection = 'user-profile' AND id = '<userId>') AS distance
FROM vector_embeddings
WHERE tenant_id = 'dev' AND collection = 'user-profile'
ORDER BY distance
LIMIT 5;
```

**pgAdmin** (http://localhost:5050, `tools`) runs in desktop mode, so there is
no login. Register a server with host `postgres`, port `5432`, user `tropis`,
password `tropis_dev_password`.

Schema tooling: [PostgreSQL migrations](#postgresql-migrations).

### MongoDB

```bash
docker exec -it tropis_mongodb mongosh tropis
docker exec tropis_mongodb mongosh --quiet --eval 'rs.status().ok'   # replica set health
```

From the host use port 27018 with `directConnection=true` (see
[Environment variables](#environment-variables)). **mongo-express**
(http://localhost:8085, `tools`) browses every collection.

### Elasticsearch

```bash
curl 'http://localhost:9200/_cluster/health?pretty'
curl 'http://localhost:9200/_cat/indices?v'
curl -X GET 'http://localhost:9200/users/_search?pretty' \
  -H 'Content-Type: application/json' \
  -d '{"query": {"match_all": {}}}'
```

**Kibana** (http://localhost:5601, `tools`) has security disabled.

### MinIO

Console: http://localhost:9902 (`minioadmin` / `minioadmin123`). The backend
creates the `app-uploads` bucket on startup if it is missing.

```bash
brew install minio/stable/mc
mc alias set local http://localhost:9900 minioadmin minioadmin123
mc ls local                            # buckets
mc cp ./myfile.pdf local/app-uploads/  # upload
mc ls local/app-uploads                # objects
```

### Mailpit

Every email the backend sends in dev (SMTP `localhost:1025`) is caught; nothing
leaves the machine. Browse them at http://localhost:8025; the same port serves
its REST API (`GET /api/v1/messages`).

### ClickHouse

```bash
docker exec -it tropis_clickhouse clickhouse-client
docker exec -it tropis_clickhouse clickhouse-client \
  --query "SELECT * FROM logs.analytics_events LIMIT 10"
```

Tables come from the init scripts — see [ClickHouse tables](#clickhouse-tables).
**CH-UI** (http://localhost:8124) connects from the browser, so use
`http://localhost:8123` with user `default`. **Metabase** (http://localhost:3200)
asks for its own setup on first visit.

### Prometheus, Grafana and Alertmanager

All three are in the `observability` profile (`make up-obs`).

- **Prometheus** (http://localhost:9090) scrapes the backend
  (`host.docker.internal:9464/metrics`, the ops port, job `nestjs`), the OTel Collector
  (`:8888`, `:8889`) and the Pulsar broker (`pulsar:8080/metrics`, job `pulsar`).
  Try the query `tropis_outbox_backlog_rows`.
- **Alert rules** load from `infra/prometheus/alerts.yml`: instance down,
  event-loop lag, heap/RSS, HTTP and RPC error rate and p95 latency
  (`tropis_http_server_*`, `tropis_rpc_server_*`), outbox `dead` / `failed` /
  PENDING backlog, outbox relay stalled, consumer dead-lettering and failure
  rate (`ConsumerDeadLettering`, `ConsumerFailureRateHigh`), BullMQ jobs
  dead-lettered (`JobsDeadLettered`), Pulsar dead-letter backlog and rate.
  Check them at http://localhost:9090/alerts. The outbox rules read
  `tropis_outbox_*` from the backend; `OutboxRelayStalled` fires when
  `tropis_outbox_relay_last_poll_timestamp_seconds` is older than 60s, which
  each relay instance updates after every completed poll.
- **Alertmanager** (http://localhost:9093) routes firing alerts per
  `infra/prometheus/alertmanager.yml`. Its Slack `api_url` is a placeholder;
  replace it with a real webhook to receive notifications.
- **Grafana** (http://localhost:3101, `admin` / `admin`) auto-provisions its
  datasources (Prometheus, Jaeger, ClickHouse via the
  `grafana-clickhouse-datasource` plugin) and two dashboards from
  `infra/grafana/dashboards/`: **Backend Overview** (ends with a
  _Reliability: Outbox & Dead Letters_ row) and **Tracking & Analytics (ClickHouse)**.
- **Jaeger** (http://localhost:16686) shows the backend's traces under the
  service name `tropis-backend` (`OTEL_SERVICE_NAME`). `src/tracing.ts` loads
  the Node auto-instrumentations (HTTP, MongoDB, Redis and the rest); how the
  trace context crosses RPC, messaging, jobs and workflows:
  [architecture.md](architecture.md#observability).

### Flink

The cluster is in the `stream` profile (`make up-stream`). The job is
built and submitted separately; starting the containers does not run it.
Start the backend with `STREAM_ENGINE=flink` first, so the Node
`AnalyticsProcessor` stops writing the same table.

```bash
bash services/flink/submit-job.sh   # build (local mvn, or a Maven container when mvn is missing) and submit
make -C services/flink submit       # the same with a local mvn
make -C services/flink logs         # follow the TaskManager log
```

The job shows as **RUNNING** in the Flink Web UI (http://localhost:8081). It
writes `logs.analytics_events` (`--ch-table`), the table the console reads.
Switching back to `STREAM_ENGINE=node` means cancelling the job in the Web UI
first; running both doubles every count.

### gRPC

Reflection is on in dev, so grpcurl needs no `-proto` flags
(`brew install grpcurl`):

```bash
grpcurl -plaintext localhost:50051 list                        # every public service
grpcurl -plaintext localhost:50051 describe tropis.user.v1.UserService

grpcurl -plaintext localhost:50051 tropis.health.v1.HealthService/Check

# Login → copy accessToken from the response; without a token the tenant comes from x-tenant-id
grpcurl -plaintext -H 'x-tenant-id: dev' \
  -d '{"email":"admin@example.com","password":"Password123!"}' \
  localhost:50051 tropis.auth.v1.AuthService/Login

# Authenticated call — Bearer token in the authorization metadata
grpcurl -plaintext -H "authorization: Bearer <access_token>" \
  localhost:50051 tropis.user.v1.UserService/GetMe

# Internal tier
grpcurl -plaintext localhost:50061 list
```

Service names, methods and message shapes are defined in
`proto/<domain>/v1/<domain>.proto` (public tier) and
`proto/<domain>/internal/v1/<domain>_internal.proto` (internal tier). Tier rules and error mapping:
[api-conventions.md](api-conventions.md).

### WebSockets

Socket.io namespace `/ws` on port 3100. The JWT goes in the handshake `auth`
object (an `Authorization: Bearer` header also works). A socket joins only its
tenant room, its own user room and one room per role of its member record, so
every push reaches one tenant, some roles of one tenant, or one user; the
socket is disconnected when its token expires or stops verifying, and moves
between role rooms when its roles change.
`make ws-listen` prints every event without writing code.

```js
import { io } from 'socket.io-client';

const socket = io('http://localhost:3100/ws', {
  auth: { token: '<jwt>' }, // accessToken from POST /api/auth/login
});

socket.on('connect', () => console.log('connected', socket.id));

socket.on('user.created', (data) => console.log('to admins', data)); // { userId, name }
socket.on('user.updated', (data) => console.log('to that user', data));
socket.on('tracking.event', (data) => console.log('to the tenant', data));
socket.on('analytics.event', (data) =>
  console.log('to admin, editor, viewer', data),
);
// in-app notifications arrive to the user under their template name

socket.emit('ping');
socket.on('pong', ({ ts }) => console.log('round-trip ms:', Date.now() - ts));
```

### OPA

Policy: `infra/opa/authz.rego` (package `authz`). Input is
`{"roles": [...], "resource": "...", "action": "..."}`.

OPA runs with `--authentication=token --authorization=basic`: the system
policy `infra/opa/system_authz.rego` admits a request only with
`Authorization: Bearer <OPA_TOKEN>`, except an unauthenticated `GET /health`
for probes. Compose starts OPA with `OPA_TOKEN` (default
`tropis-dev-opa-token`, overridable from the shell), and the backend sends its
own `OPA_TOKEN` from `apps/backend/.env`; the two must match, or every
authorization check fails as `SERVICE_UNAVAILABLE` and the policy health
reports `down`. Rego unit tests:
`docker run --rm -v "$PWD/infra/opa:/policies:ro" openpolicyagent/opa:1.20.1 test /policies`.

```bash
OPA_TOKEN=tropis-dev-opa-token

# Can an editor update a user? → true
curl -s -X POST http://localhost:8181/v1/data/authz/allow \
  -H "Authorization: Bearer $OPA_TOKEN" -H 'Content-Type: application/json' \
  -d '{"input":{"roles":["editor"],"resource":"user","action":"update"}}' | jq

# Can a viewer delete a user? → false
curl -s -X POST http://localhost:8181/v1/data/authz/allow \
  -H "Authorization: Bearer $OPA_TOKEN" -H 'Content-Type: application/json' \
  -d '{"input":{"roles":["viewer"],"resource":"user","action":"delete"}}' | jq

# Every action a role may take on a resource
curl -s -X POST http://localhost:8181/v1/data/authz/allowed_actions \
  -H "Authorization: Bearer $OPA_TOKEN" -H 'Content-Type: application/json' \
  -d '{"input":{"roles":["editor"],"resource":"user"}}' | jq

# Apply a Rego edit — no backend redeploy needed
docker compose -f infra/docker/docker-compose.yml restart opa
```

### Temporal

- **Web UI** (`tools`): http://localhost:8233 — running / completed / failed
  workflows, event history, signals, terminate.
- **Workflow:** `userOnboardingWorkflow` (a durable follow-up timer), defined in
  `apps/backend/src/modules/user/workflows/onboarding.workflow.ts` with its activities in
  `onboarding.activities.ts`, executed by the worker role (one Temporal worker per registered
  queue, here `user-onboarding`; in-process under `make dev`), started by `OnboardingService`
  when the user consumer applies `identity.user.created`, and read
  back through `GET /api/workflows/onboarding` (admin only). The delay is
  `ONBOARDING_FOLLOWUP_DELAY_MS`. In the Web UI an execution's id is
  `t.<tenantId>:onboarding-<userId>`: the adapter prefixes every id with its
  tenant.
- **Demo:** `make wf-demo` (add `CRASH=1` for the crash-recovery variant). The
  script runs the shipped role bundles, `dist/public/main.js` (API on :3100)
  and `dist/worker/main.js` (consumers, relay and the Temporal worker; ops on
  :9465), rebuilding them first when `src/` is newer, and stops both on exit;
  the crash variant kills both mid-timer and starts them again. It refuses to
  start while something else answers on :3100, so stop `make dev` first. It
  waits for `GET /api/health`, the worker's `/readyz` and the Temporal worker
  to start, so the core stack must be healthy (`make up`); logs go to
  `$TMPDIR/tropis-wf-demo/`, and the follow-up emails land in Mailpit
  (http://localhost:8025).

```bash
docker logs tropis_temporal                                          # Temporal server
docker exec -it tropis_temporal_postgres psql -U temporal -d temporal  # Temporal's own Postgres (not the app DB)
```

The worker logs event `workflow.worker-started` (`temporal.task_queue: user-onboarding`)
in the backend's own output.

### BullMQ

The app enqueues jobs itself (for example the welcome notification on user
create; the scheduler role enqueues `outbox-maintenance` sweeps). Queues:
`notification` (declared by `modules/notification/` with `JobsModule.forFeature`),
`outbox-maintenance` (declared by `infrastructure/outbox/`) and `dead-letter`
(owned by the jobs capability, `src/infrastructure/jobs/jobs.registry.ts`). Bull Board, mounted only in the
`all` role (`make dev`) outside production, without authentication, and
answering only direct requests from localhost, at
http://localhost:3100/api/queues shows waiting, active, completed and failed
jobs with per-job data and retry controls. A `notification` job that exhausts
its attempts is copied to `dead-letter` with `__sourceQueue`, `__sourceJobId`,
`__sourceOpts` and `__failReason`. Retrying it in Bull Board re-runs it inside
the dead-letter queue; replaying it to its source queue is
`make jobs-dlq-replay ID=<dlq job id>` (`make jobs-dlq` lists the entries),
which retries the failed source job with a fresh attempt budget, or
re-enqueues it with its recorded attempts and backoff, then removes the
dead-letter entry. Raw state lives in Redis under `bull:<queue>:*`.

### Vault

- **Web UI:** http://localhost:8200, sign in with token `dev-root-token`.
  - **Secrets** → `secret/tropis` is the flat map the backend reads; the
    subpaths `secret/tropis/{db,auth,messaging,storage,smtp}` mirror it grouped
    for browsing. The seeded set is in `infra/vault/init.sh`.
  - **Policies** → `tropis-app`, the app's read-only policy.
  - **Access** → AppRole `tropis-app`, token TTLs and capabilities.
- Wiring the backend to Vault: [Vault](#vault-setup) under local setup tasks.
  Why only the backend talks to Vault: [architecture.md](architecture.md).

```bash
docker exec -it tropis_vault sh
export VAULT_TOKEN=dev-root-token
vault kv get secret/tropis                                   # every secret
vault kv get secret/tropis/auth                              # one group
vault kv patch secret/tropis JWT_SECRET=new-super-secret-value-at-least-32-chars   # read at the next start, only if the environment does not set JWT_SECRET
vault token lookup <app-token>                               # a token's policies and TTL
```

## Environment variables

`make install` copies `apps/backend/.env.example` to `apps/backend/.env` and
`apps/frontend/helm/.env.example` to `apps/frontend/helm/.env`. The example
files hold the full list with inline comments. harbor has no `.env` file.

The backend validates variables with Joi (`apps/backend/src/config/env.validation.ts`)
at startup and exits with every validation error listed; unknown variables are
allowed. `JWT_SECRET` is the only required one (at least 32 characters, no
default). Variables read by the code but outside the schema are marked below.

### Backend (`apps/backend/.env`)

| Variable                                                                                             | Default / dev value                                                             | Notes                                                                                                                                                                                                                                                   |
| ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PORT` / `RPC_PUBLIC_PORT` / `RPC_INTERNAL_PORT`                                                     | `3100` / `50051` / `50061`                                                      | HTTP+WS / public RPC / internal RPC listeners                                                                                                                                                                                                           |
| `OPS_PORT`                                                                                           | `9464`                                                                          | ops listener on every role: `/livez`, `/readyz`, `/metrics`                                                                                                                                                                                             |
| `NODE_ENV`                                                                                           | `development`                                                                   | `development`, `production` or `test`; `production` hides Swagger and Bull Board (which only the `all` role serves anyway) and turns off gRPC reflection                                                                                                |
| `GRPC_REFLECTION`                                                                                    | `false`                                                                         | forces reflection on in production; not needed in dev                                                                                                                                                                                                   |
| `CORS_ORIGIN`                                                                                        | `http://localhost:5173`                                                         | comma-separated absolute URLs; the first is where OAuth callbacks redirect                                                                                                                                                                              |
| `LOG_LEVEL`                                                                                          | `info`                                                                          | `trace`, `debug`, `info`, `warn`, `error`                                                                                                                                                                                                               |
| `LOG_FORMAT`                                                                                         | empty                                                                           | `json` writes JSON lines in development too (production always does); read from the environment before config loads                                                                                                                                     |
| `SHUTDOWN_TIMEOUT_MS`                                                                                | `55000` (worker) / `20000` (other roles)                                        | hard deadline for a whole graceful shutdown, after which the process exits anyway, so it ends inside the pod's termination grace period; read from the environment                                                                                      |
| `BOOT_TIMEOUT_MS`                                                                                    | `150000`                                                                        | the process exits if boot has not finished by then, because `/livez` answers from the start and would never restart a hung boot; read from the environment                                                                                              |
| `JWT_SECRET` / `JWT_EXPIRES_IN`                                                                      | required / `15m`                                                                | secret must be ≥ 32 chars                                                                                                                                                                                                                               |
| `COOKIE_SECURE`                                                                                      | on unless `NODE_ENV` is `development` or `test`                                 | `Secure` flag of the `tropis_rt` refresh cookie; set `false` only to serve plain HTTP outside development                                                                                                                                               |
| `OAUTH_TENANT_ID`                                                                                    | empty                                                                           | tenant Google/GitHub sign-ins land in; empty makes OAuth callbacks fail with `TENANT_REQUIRED`. It must be registered and active, and first sign-ins need its `selfSignup` on                                                                           |
| `NATIVE_OAUTH_REDIRECTS`                                                                             | `tropis://auth/callback`                                                        | comma-separated custom-scheme URLs an OAuth sign-in may return a native shell to (exact match; no http(s), no fragment); empty turns native OAuth off ([api-conventions.md](api-conventions.md#native-sessions))                                        |
| `API_KEYS`                                                                                           | dev key `svc-ingest` for tenant `dev` in the example; schema default `{}`       | JSON map `{"<keyId>": {"secret": "...", "tenantId": "..."}}` for HMAC-signed REST; a signed request runs in its key's tenant; any other shape fails validation at startup; `{}` disables the signed tier — see [api-conventions.md](api-conventions.md) |
| `SERVICE_TOKEN`                                                                                      | empty                                                                           | internal RPC tier identity (`x-service-token`); empty disables the tier (`UNIMPLEMENTED`)                                                                                                                                                               |
| `RATE_LIMIT_TTL_MS` / `RATE_LIMIT_DEFAULT` / `RATE_LIMIT_AUTH` / `RATE_LIMIT_REFRESH`                | `60000` / `100` / `10` / `60`                                                   | per-client-address limits, counted in Redis across replicas; `RATE_LIMIT_AUTH` covers login, the OAuth code exchange and OAuth callbacks; refresh has its own `RATE_LIMIT_REFRESH`, because it runs on every page load                                  |
| `SIGNUP_RATE_LIMIT_IP` / `SIGNUP_RATE_LIMIT_TENANT` / `SIGNUP_RATE_LIMIT_WINDOW_S`                   | `10` / `200` / `3600`                                                           | self sign-ups per client address (across tenants) and per tenant per window; over the limit → `RATE_LIMITED`; fail open when Redis is down                                                                                                              |
| `E2E_RATE_LIMIT_AUTH` / `E2E_SIGNUP_RATE_LIMIT` _(Makefile variables)_                               | `200` / `1000`                                                                  | `make test-e2e` starts the backend with `RATE_LIMIT_AUTH` and both sign-up limits set to them, because the suite makes many real sign-ins and sign-ups from one address                                                                                 |
| `KEYSPACE_APP` / `KEYSPACE_ENV`                                                                      | `tropis` / `NODE_ENV`                                                           | `{app}:{env}` prefix of every cache, kv, lock, ratelimit and dedup key                                                                                                                                                                                  |
| `CACHE_ADAPTER` / `LOCK_ADAPTER` / `RATE_LIMIT_ADAPTER` / `DEDUP_ADAPTER`                            | `redis`                                                                         | `redis` or `disabled`                                                                                                                                                                                                                                   |
| `KV_ADAPTER`                                                                                         | `redis`                                                                         | `redis`, `aerospike` or `disabled`                                                                                                                                                                                                                      |
| `VECTOR_ADAPTER` / `SEARCH_ADAPTER` / `OLAP_ADAPTER` / `OBJECTS_ADAPTER` / `WORKFLOW_ADAPTER`        | `pgvector` / `elasticsearch` / `clickhouse` / `minio` / `temporal`              | that adapter or `disabled`                                                                                                                                                                                                                              |
| `GRAPH_ADAPTER`                                                                                      | `disabled`                                                                      | `neo4j` or `disabled`; `neo4j` needs the `graph` profile                                                                                                                                                                                                |
| `REALTIME_ADAPTER`                                                                                   | `redis`                                                                         | `redis` (pushes reach sockets in every process) or `local` (only the publishing process)                                                                                                                                                                |
| `SECRETS_ADAPTER`                                                                                    | `vault`                                                                         | `vault` or `env`; with `env`, `encrypt()` returns null and callers redact                                                                                                                                                                               |
| `MAIL_ADAPTER`                                                                                       | `smtp`                                                                          | `smtp` or `log` (messages are logged, not sent)                                                                                                                                                                                                         |
| `SIGNING_ADAPTER` / `SIGNING_SERVICE_URL`                                                            | `inprocess` / `http://localhost:50052`                                          | `native` verifies signatures through `services/rust/signing`, which needs the same `API_KEYS`                                                                                                                                                           |
| `STREAM_ENGINE`                                                                                      | `node`                                                                          | the one writer of analytics events to OLAP: `node` (`AnalyticsProcessor`) or `flink` (`services/flink`) — see [Flink](#flink)                                                                                                                           |
| `MESSAGING_ADAPTER`                                                                                  | `pulsar`                                                                        | adapter behind `MessagingPort`: `pulsar`, `kafka` or `disabled`; the Pulsar connection is opened only with `pulsar`                                                                                                                                     |
| `MESSAGING_MAX_REDELIVERIES` / `MESSAGING_REDELIVERY_DELAY_MS` / `MESSAGING_MAX_REDELIVERY_DELAY_MS` | `10` / `1000` / `30000`                                                         | redelivery of a failed message: the delay doubles from the base up to the ceiling (at most `50000`, below the 60 s ack timeout), then the message is dead-lettered                                                                                      |
| `PULSAR_SERVICE_URL`                                                                                 | `pulsar://localhost:6650`                                                       |                                                                                                                                                                                                                                                         |
| `KAFKA_BROKERS` / `KAFKA_CLIENT_ID`                                                                  | `localhost:9092` / `tropis-backend`                                             | used when `MESSAGING_ADAPTER=kafka`                                                                                                                                                                                                                     |
| `OUTBOX_RETENTION_DAYS`                                                                              | `7`                                                                             | days a dispatched or skipped outbox row is kept before its TTL deletes it                                                                                                                                                                               |
| `MONGODB_URI`                                                                                        | `mongodb://localhost:27018/tropis?directConnection=true` in the example         | keep the line: the schema default `mongodb://localhost:27017/tropis` does not reach the local container; see the MongoDB note below                                                                                                                     |
| `REDIS_HOST` / `REDIS_PORT` / `REDIS_PASSWORD`                                                       | `localhost` / `6379` / empty                                                    |                                                                                                                                                                                                                                                         |
| `CLICKHOUSE_HOST` / `_USER` / `_PASSWORD` / `_DATABASE`                                              | `http://localhost:8123` / `default` / empty / `logs`                            |                                                                                                                                                                                                                                                         |
| `NEO4J_URI` / `_USER` / `_PASSWORD`                                                                  | `bolt://localhost:7687` / `neo4j` / `tropis_dev_password` in the example        | used when `GRAPH_ADAPTER=neo4j`                                                                                                                                                                                                                         |
| `AEROSPIKE_HOSTS`                                                                                    | `localhost:3000`                                                                | comma-separated `host:port` list, read by `aerospike-connection.module.ts` when `KV_ADAPTER=aerospike`                                                                                                                                                  |
| `POSTGRES_HOST` / `_PORT` / `_USER` / `_PASSWORD` / `_DB` / `_SSL`                                   | `localhost` / `5432` / `tropis` / `tropis_dev_password` / `tropis` / `false`    | Vault dynamic credentials replace user/password when available                                                                                                                                                                                          |
| `POSTGRES_SSL_CA`                                                                                    | empty                                                                           | PEM of the CA behind the server certificate (with `POSTGRES_SSL=true`); TLS always verifies the certificate, against the system roots when unset                                                                                                        |
| `DATABASE_URL` _(outside schema)_                                                                    | `postgres://tropis:tropis_dev_password@localhost:5432/tropis` in the example    | read only by node-pg-migrate (`make migrate`), not by the backend                                                                                                                                                                                       |
| `TYPEORM_SYNC`                                                                                       | `false`; `true` in the example                                                  | TypeORM `synchronize` (boolean) — keep it off outside local dev                                                                                                                                                                                         |
| `POSTGRES_RETRY_ATTEMPTS` / `POSTGRES_RETRY_DELAY`                                                   | `30` / `3000`                                                                   | connection retries at startup                                                                                                                                                                                                                           |
| `ELASTICSEARCH_NODE` / `_USERNAME` / `_PASSWORD`                                                     | `http://localhost:9200` / empty / empty                                         |                                                                                                                                                                                                                                                         |
| `OPA_URL` / `OPA_TOKEN`                                                                              | `http://localhost:8181` / empty; `tropis-dev-opa-token` in the example          | `OPA_TOKEN` is sent as a bearer token and must equal the token OPA runs with (`--authentication=token`; Compose default `tropis-dev-opa-token`)                                                                                                         |
| `MINIO_ENDPOINT` / `_PORT` / `_USE_SSL` / `_ACCESS_KEY` / `_SECRET_KEY` / `_BUCKET`                  | `localhost` / `9900` / `false` / `minioadmin` / `minioadmin123` / `app-uploads` |                                                                                                                                                                                                                                                         |
| `SMTP_HOST` / `_PORT` / `_FROM` / `_USER` / `_PASS`                                                  | `localhost` / `1025` / `noreply@tropis.local` / empty / empty                   | Mailpit in dev                                                                                                                                                                                                                                          |
| `OTEL_SERVICE_NAME` / `OTEL_EXPORTER_OTLP_ENDPOINT`                                                  | `tropis-backend` / `http://localhost:4318/v1/traces`                            | traces go to the OTel Collector (`observability` profile)                                                                                                                                                                                               |
| `SERVICE_VERSION` / `SERVICE_ROLE`                                                                   | package version / set by the entry                                              | `service.version` / `service.role` on every span and log record; the role is set by the entry point (`src/roles/<role>/role.ts`: `all`, `public`, `private`, `worker` or `scheduler`), not by configuration                                             |
| `TEMPORAL_ADDRESS` / `TEMPORAL_NAMESPACE`                                                            | `localhost:7233` / `default`                                                    | each workflow queue is declared by its module (`user-onboarding`)                                                                                                                                                                                       |
| `ONBOARDING_FOLLOWUP_DELAY_MS`                                                                       | `30000`                                                                         | onboarding workflow's follow-up timer                                                                                                                                                                                                                   |
| `VAULT_ADDR` / `VAULT_TOKEN` / `VAULT_SECRET_PATH`                                                   | `http://localhost:8200` / empty / `secret/data/tropis`                          | see [Vault setup](#vault-setup)                                                                                                                                                                                                                         |
| `VAULT_ROLE_ID` / `VAULT_SECRET_ID`                                                                  | empty                                                                           | AppRole login; takes precedence over `VAULT_TOKEN`                                                                                                                                                                                                      |
| `GOOGLE_CLIENT_ID` / `_SECRET` / `_CALLBACK_URL`                                                     | empty / empty / `http://localhost:3100/api/auth/google/callback`                | see [OAuth](#oauth)                                                                                                                                                                                                                                     |
| `GITHUB_CLIENT_ID` / `_SECRET` / `_CALLBACK_URL`                                                     | empty / empty / `http://localhost:3100/api/auth/github/callback`                | see [OAuth](#oauth)                                                                                                                                                                                                                                     |

**MongoDB:** the container runs a single-node replica set `rs0`, which the
outbox needs for transactions. From the host keep `directConnection=true` on
port 27018: the member advertises `mongodb:27017`, a Docker-network name that
does not resolve on the host, so topology discovery would fail.

**Multi-tenancy:** there is no fallback tenant. Everything takes the tenant
from the token or `X-Tenant-ID` ([Adding a tenant](#adding-a-tenant)); OAuth
sign-ins use `OAUTH_TENANT_ID`.

**Adding a variable:** add it to `apps/backend/.env.example`, and to the Joi
schema when it needs validation or a default.

### helm (`apps/frontend/helm/.env`)

| Variable            | Dev value                | Notes                                                  |
| ------------------- | ------------------------ | ------------------------------------------------------ |
| `VITE_RPC_URL`      | `http://localhost:50051` | backend public RPC listener (Connect protocol)         |
| `VITE_WS_URL`       | `http://localhost:3100`  | Socket.io endpoint (backend HTTP port)                 |
| `VITE_API_BASE_URL` | `http://localhost:3100`  | bare origin **without** `/api` — the SDK appends it    |
| `VITE_SITE_URL`     | `http://localhost:5173`  | public origin for absolute canonical / Open Graph URLs |
| `VITE_TENANT_ID`    | `dev`                    | tenant the console signs in to (sent as `X-Tenant-ID`) |

## Local setup tasks

### Vault setup

`vault` (dev mode: in-memory, unsealed, root token `dev-root-token`) and the
one-shot `vault-init` are the `secrets` profile, which `make up` includes. `vault-init` runs
`infra/vault/init.sh`: it writes the KV secrets, the `tropis-app` policy, an
AppRole, the Transit key `user-data` (unused by the app) and dynamic PostgreSQL credentials
(`database/creds/tropis-app`), then prints the values to paste:

```bash
docker logs tropis_vault_init
```

Pick one option and put it in `apps/backend/.env`:

```env
# Option A — static token
VAULT_ADDR=http://localhost:8200
VAULT_TOKEN=dev-root-token
VAULT_SECRET_PATH=secret/data/tropis

# Option B — AppRole (values from the vault-init log)
VAULT_ADDR=http://localhost:8200
VAULT_ROLE_ID=<role_id>
VAULT_SECRET_ID=<secret_id>
VAULT_SECRET_PATH=secret/data/tropis
```

The seeded secrets use Docker-network hostnames (`mongodb`, `redis`, …), which
only resolve inside compose, so keep the `localhost` values in `.env`: Vault
fills only keys that are not already set. How the backend loads and merges
Vault secrets: [architecture.md](architecture.md#secrets-vault).

### OAuth

Google and GitHub sign-in stay disabled until both the client ID and secret are
set; an unconfigured provider answers `501` with code `OAUTH_NOT_CONFIGURED`.

**Google:** Google Cloud Console → APIs & Services → Credentials → Create OAuth
2.0 Client ID (Web application) → authorised redirect URI
`http://localhost:3100/api/auth/google/callback`.

**GitHub:** Settings → Developer settings → OAuth Apps → New OAuth App →
callback URL `http://localhost:3100/api/auth/github/callback`.

```env
GOOGLE_CLIENT_ID=your-google-client-id
GOOGLE_CLIENT_SECRET=your-google-client-secret
GOOGLE_CALLBACK_URL=http://localhost:3100/api/auth/google/callback

GITHUB_CLIENT_ID=your-github-client-id
GITHUB_CLIENT_SECRET=your-github-client-secret
GITHUB_CALLBACK_URL=http://localhost:3100/api/auth/github/callback
```

Set `OAUTH_TENANT_ID` to a registered, active tenant; a first sign-in creates
an account there only when the tenant has `selfSignup` on
([Adding a tenant](#adding-a-tenant)). After a successful sign-in the backend
redirects to `<first CORS_ORIGIN>/auth/callback#code=<one-time code>`; helm's
`/auth/callback` route trades the code (valid 60 s, once) for a token pair
through `POST /api/auth/oauth/exchange` (`completeOAuthSignIn` in
`@tropis/sdk`). The sign-in flow and account linking:
[architecture.md](architecture.md#oauth2--sso).

### Adding a tenant

There is no tenant API and no default tenant. A tenant exists once it is
registered in the tenant directory (the MongoDB `tenants` collection): sign-up,
login and every token of an unregistered or suspended tenant are refused
([architecture.md](architecture.md#tenant-directory)). `make seed` registers
`dev` with self sign-up on, and the backend e2e suite registers `e2e`.

```bash
make tenant-create ID=tenant-a NAME='Tenant A' SELF_SIGNUP=true   # register, or update an existing one
make tenant-create ID=tenant-a NAME='Tenant A' STATUS=suspended   # suspend it (within 60 s on every process)
```

`SELF_SIGNUP` defaults to `false`: only an admin of the tenant can then add
users. Calls without a token name their tenant with `X-Tenant-ID`, so sign-up
and login land in the tenant the header names:

```bash
grpcurl -plaintext -H 'x-tenant-id: tenant-a' \
  -d '{"name":"Admin","email":"admin@tenant-a.test","password":"Password123!"}' \
  localhost:50051 tropis.user.v1.UserService/Create

make promote-admin EMAIL=admin@tenant-a.test TENANT_ID=tenant-a   # optional: make it the tenant's admin

curl -s -X POST http://localhost:3100/api/auth/login \
  -H 'Content-Type: application/json' -H 'X-Tenant-ID: tenant-a' \
  -d '{"email":"admin@tenant-a.test","password":"Password123!"}'
```

Emails are unique per tenant, not globally. The issued JWT carries
`tenantId`; afterwards a header naming another tenant is rejected
(`TENANT_MISMATCH`). helm signs in to `VITE_TENANT_ID` (`dev` when unset); the
seeder, `promote-admin` and the dev tools use `TENANT_ID` (`dev` when unset),
so by default they all meet in one tenant. OAuth sign-ins land in
`OAUTH_TENANT_ID`.

### PostgreSQL migrations

Tooling is node-pg-migrate (`apps/backend/.node-pg-migraterc`): files in
`apps/backend/migrations/`, JavaScript, timestamp-prefixed, connection from
`DATABASE_URL` (read from `apps/backend/.env`, set in the example).
Migrations are the only source of tables, grants and policies:

| Migration                                | Creates                                                                               |
| ---------------------------------------- | ------------------------------------------------------------------------------------- |
| `1700000000000_initial-schema.js`        | the pgvector extension and `vector_embeddings` (384 dimensions, IVFFlat cosine index) |
| `1700000000001_tenancy.js`               | the `tropis_tenant_scope` role and grants, row-level security on `vector_embeddings`  |
| `1700000000002_drop-tenants-registry.js` | drops the relational `tenants` table: the tenant directory lives in MongoDB           |

```bash
make migrate                                                      # up
pnpm --filter @tropis/backend migrate:down                        # roll back the last one
pnpm --filter @tropis/backend migrate:create my-change-name       # new migration file
```

`infra/postgres/init.sql` runs once on the first start of an empty volume, as
the superuser, and provides only what a migration user may lack the privilege
to create: the `vector` extension and the `tropis_tenant_scope` role, granted
to the connecting user. The backend never changes the schema, so its runtime
user needs no DDL privilege and replicas cannot race on it: at startup and on
every health check until it matches, the pgvector adapter verifies that
`vector_embeddings` exists with the 384-dimension `embedding` column, forced
row-level security and the `tenant_isolation` policy, and until then reports
`vector` as `down` with the missing piece and `run the relational migrations
(make migrate)`. `vector` is not a readiness dependency of any role, so the
role stays ready and lists it in `degraded`; it turns `up` without a restart
once `make migrate` has run. `make test-e2e` runs the migrations itself.
Rollback rules for production:
[deployment.md](deployment.md).

### ClickHouse tables

`infra/clickhouse/init-analytics.sql`, `init-tracking.sql` and `init-audit.sql` are mounted into the container and run on the **first**
start with an empty volume. To apply them again:

```bash
docker exec -i tropis_clickhouse clickhouse-client < infra/clickhouse/init-analytics.sql
docker exec -i tropis_clickhouse clickhouse-client < infra/clickhouse/init-tracking.sql
docker exec -i tropis_clickhouse clickhouse-client < infra/clickhouse/init-audit.sql
```

`tenant_id` is the leading sort-key column of `logs.analytics_events` and
`logs.analytics_minutely_agg`, and ClickHouse cannot add
a leading key column in place. A database whose tables lack that column is
rebuilt once with `infra/clickhouse/migrations/001-add-tenant-id.sql`. The
script sets `tenant_id = 'default'` on every row it copies, so it must never
run against tables that already carry `tenant_id` — it would erase the real
tenant of every row.

## Troubleshooting

### A container did not start

It probably belongs to a profile. A plain `make up` starts core only; see
[Compose profiles](#compose-profiles) for which profile owns what, or run
`docker compose -f infra/docker/docker-compose.yml --profile <name> config --services`.

### Health check returns 503

The probed dependencies and what each one's outage does:
[tech-decisions.md](tech-decisions.md#degradation-behavior). The `/api/health`
503 body is a problem document (`code: "HEALTH_CHECK_FAILED"`) whose `checks` array lists
every probe as up or down; the backend logs the same list as event
`http.health-check-failed`. Both `/api/health` and `/readyz` on the ops port
answer 503 when a dependency the role requires is down (`READINESS_PROBES`;
under `make dev`: `documents`, `cache`, `kv`, `ratelimit`, `lock`, `dedup`, `policy`, `messaging`, `consumers`, `jobs`);
every other down capability is listed in `degraded` with a 200. `/api/health`
runs every probe; `/readyz` runs only the required ones plus the probes that
cost no network round trip (`consumers`), and answers 503 `{"status":"starting"}`
until boot has finished. Then read the
failing container's logs.

Common causes: Elasticsearch or Pulsar still warming up, the stack started with `make up-core`, the MongoDB replica set not
ready, or a Docker service name in `.env` (from the host use `localhost`;
service names resolve only inside the compose network).

### Containers exit or keep restarting

Elasticsearch, Pulsar, ClickHouse and Flink are memory-hungry. Symptoms: exit
code 137 (OOM-killed), Elasticsearch stuck initialising, a Pulsar restart loop.

- Give Docker Desktop at least 8 GB; 10–12 GB is comfortable for `make up-all`.
- Start only what you need: `make up` instead of `make up-all`.
- Elasticsearch on Linux may need `sudo sysctl -w vm.max_map_count=262144`.
- Find the culprit: `docker compose -f infra/docker/docker-compose.yml ps`, then
  `docker compose -f infra/docker/docker-compose.yml logs <service>`.

### Pulsar fails topics with `Error while recovering ledger`

Local Pulsar runs standalone in ZooKeeper metadata mode
(`PULSAR_STANDALONE_USE_ZOOKEEPER=1`), because that mode gives the bookie a
fixed identity (`127.0.0.1:3181`); the default RocksDB mode picks a random
bookie port on every start, so a recreated container can no longer read the
ledgers its volume holds. The service gets 60 s to stop cleanly
(`stop_grace_period`).

After a hard stop (`docker kill`, a Docker Desktop crash) the bookie's old
registration outlives the restart and it fails to register once; restart it
again and the data is readable:

```bash
docker restart tropis_pulsar
```

A volume whose ledgers still fail after that restart (for example one written
in RocksDB mode) cannot be recovered. Local Pulsar holds only replayable dev
traffic, so replace the volume:

```bash
docker compose -f infra/docker/docker-compose.yml rm -sf pulsar
docker volume rm tropis_pulsar_data
make up
```

### MongoDB replica set not initialised

Symptom: `Transaction numbers are only allowed on a replica set member`. The
replica set is initiated by `infra/docker/mongo-rs-init.js` on the first start
of an empty volume. Check and repair:

```bash
docker exec tropis_mongodb mongosh --quiet --eval 'rs.status().ok'
docker exec tropis_mongodb mongosh --quiet --eval 'rs.initiate()'          # only if the check fails
docker compose -f infra/docker/docker-compose.yml up mongo-rs-reconfig    # then point the member at mongodb:27017
```

If the volume is in a bad state, run
`docker compose -f infra/docker/docker-compose.yml --profile '*' down -v`
(wipes all data) and start again. Without `--profile '*'` the volumes of
profiled containers stay in use and cannot be removed. Keep `MONGODB_URI` on host port 27018 with
`directConnection=true`, as in `.env.example`.

### A container cannot reach MongoDB, or mongo-express crash-loops

The member must advertise `mongodb:27017`, the compose service name.
`mongo-rs-init.js` can only seed `localhost:27017`: the initdb mongod binds to
loopback, so any other host fails its isSelf check and the container exits. A
set advertising `localhost` is unusable by clients that perform topology
discovery — they resolve the member to their own loopback and get
`ECONNREFUSED ::1:27017`. mongo-express is such a client, because it drops
query options and cannot be told `directConnection=true`.

The one-shot `mongo-rs-reconfig` service moves the member once mongod is
listening. Check it:

```bash
docker logs tropis_mongo_rs_reconfig                                      # "member now advertises mongodb:27017"
docker exec tropis_mongodb mongosh --quiet --eval 'rs.conf().members[0].host'
```

If the host is still `localhost:27017`, run it again (it is idempotent):

```bash
docker compose -f infra/docker/docker-compose.yml up mongo-rs-reconfig
```

Host clients are a separate case: `mongodb` does not resolve outside Docker, so
`MONGODB_URI` keeps `directConnection=true` against port 27018.

### Redis keys missing: a local Redis shadows the container

Symptom: the backend works (auth, dedup, caching behave), but
`docker exec tropis_redis redis-cli ...` shows an empty Redis and keys such as
`tropis:development:t.<tenant>:cache:user:profile:v1:<id>` are nowhere.

Cause: a local (Homebrew) Redis on `127.0.0.1:6379` shadows `tropis_redis` for
host processes such as `make dev`. macOS resolves `localhost` to `127.0.0.1`
first, so the host backend talks to the local Redis while `docker exec` queries
the empty container.

```bash
lsof -iTCP:6379 -sTCP:LISTEN -n -P        # shows both a local redis-server and com.docker
redis-cli -h 127.0.0.1 -p 6379 dbsize     # where the host backend's keys actually are
brew services stop redis                  # make tropis_redis authoritative, then restart make dev
```

### RPC CORS errors

Symptom: browser console `CORS policy` errors on calls to `localhost:50051`.

- The public RPC listener echoes back only the origins in the backend's
  `CORS_ORIGIN` (plus the fixed native-shell origins), the same list REST uses.
  Add your frontend origin to `CORS_ORIGIN` in `apps/backend/.env` and restart
  the backend.
- OPTIONS preflight fails but the origin is listed: the request sends a header
  beyond the Connect protocol headers and `Authorization`, `X-Request-Id`,
  `X-Tenant-Id`, `Traceparent` and `Tracestate`, which is all
  `infrastructure/rpc/rpc-cors.ts` allows.
- Check the listener is up with `nc -z localhost 50051`.

### Port conflicts

Aerospike holds host ports 3000, 3001 and 3003, which is why the backend runs
on 3100, Grafana on 3101 and Metabase on 3200. Other easily-hit ports: Pulsar
admin 8080, Flink 8081, Temporal UI 8233.

```bash
lsof -i :3100
```

Stop the other process, or change the host side of the mapping in
`infra/docker/docker-compose.yml` (and the matching value in `.env`).

### harbor dev server returns 500 with `ENOENT .next/routes-manifest.json`

`next dev` and `next build` share `apps/frontend/harbor/.next`, so a build while
the dev server runs pulls the manifest out from under it. The usual trigger is
`pnpm -r build` / `make build` in another terminal. Symptoms, in order: missing
stylesheets (`GET /_next/static/css/app/layout.css` → 404, unstyled page), then
500 on every route.

Fix: stop the dev server, `rm -rf apps/frontend/harbor/.next`, start it again.
To check harbor's rendered output while builds run, use the production server,
which does not race with `next dev`:

```bash
pnpm --filter @tropis/harbor build && pnpm --filter @tropis/harbor start   # http://localhost:4000
```

### pnpm workspace issues

- `Cannot find module '@tropis/shared'` → `pnpm --filter @tropis/shared build`,
  then `pnpm install` to relink.
- Nested or phantom `node_modules` → run `pnpm install` from the repo root only;
  never `npm install` inside a package.
- A native dependency fails to build → build scripts are allow-listed in
  `pnpm.onlyBuiltDependencies` in the root `package.json`; check it is listed.
- Lockfile mismatch in CI → reproduce with `pnpm install --frozen-lockfile`, then
  run `pnpm install` and commit the updated `pnpm-lock.yaml`.

### Vault errors

- Secrets, policy or AppRole missing → dev mode keeps everything in memory, so
  restarting `vault` empties it. Re-seed with
  `docker compose -f infra/docker/docker-compose.yml restart vault vault-init`,
  and copy the new AppRole `secret_id` from `docker logs tropis_vault_init` if
  you use Option B.
- `permission denied` → the token or AppRole in `apps/backend/.env` does not
  match the running Vault, or lacks a path in the `tropis-app` policy written by
  `infra/vault/init.sh`.
- `connection refused` → `docker compose -f infra/docker/docker-compose.yml logs vault`,
  and check port 8200 is published.
- Dynamic DB credentials warn in the vault-init log → PostgreSQL is not ready yet;
  re-run `vault-init` once `postgres` is up.
