# Troubleshooting

Common local-dev issues with the container stack (`infra/docker/docker-compose.yml`).

## Compose profiles — "my container didn't start"

Optional services sit behind compose profiles and are **not** started by a plain
`docker compose up -d` / `make up`. If a container is "missing", check which profile owns it:

| Profile         | Started by                                                               | What it owns                                                                              | Docs                                                                                                                        |
| --------------- | ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| _(none — core)_ | `make up`                                                                | every datastore, broker, and infra dependency the backend health check probes (+ mailhog) | TECH-DECISIONS: Redis vs Aerospike, MongoDB vs PostgreSQL, BullMQ vs Temporal, Pulsar, ClickHouse, Vault, OPA, MinIO, Envoy |
| `analytics`     | `make up-analytics`                                                      | Flink stream-processing cluster                                                           | TECH-DECISIONS: Flink                                                                                                       |
| `observability` | `make up-obs`                                                            | tracing + metrics pipeline (collector, trace UI, metrics, alerting, dashboards)           | ARCHITECTURE (tracing/metrics)                                                                                              |
| `rust`          | `docker compose -f infra/docker/docker-compose.yml --profile rust up -d` | signing (Rust gRPC HMAC service, :50052)                                                  | TECH-DECISIONS: Rust vs TypeScript; services/rust/signing/README.md                                                         |
| `tools`         | `make up-tools`                                                          | web UIs for every datastore/broker                                                        | UI-only helpers                                                                                                             |

Which containers belong to which profile (and their ports): `infra/docker/docker-compose.yml` — or `docker compose -f infra/docker/docker-compose.yml --profile <name> config --services`.

Under the `observability` profile, Grafana auto-provisions its datasources (Prometheus, Jaeger, ClickHouse via the `grafana-clickhouse-datasource` plugin) and two dashboards from `infra/grafana/dashboards/` (**Backend Overview** and **Tracking & Analytics**) — no manual import needed. The **Backend Overview** dashboard ends with a _Reliability: Outbox & Dead Letters_ row (DEAD row count, backlog by status, relay poll age, Pulsar DLQ backlog, tracking duplicate drops). Prometheus loads alert rules from `infra/prometheus/alerts.yml` (instance down, event-loop lag, heap/RSS, HTTP 5xx/latency, outbox DEAD/FAILED/PENDING backlog, outbox relay stalled, Pulsar dead-letter backlog and rate); check them at http://localhost:9090/alerts. The outbox and Pulsar rules read `tropis_outbox_*` from the backend (`nestjs` job) and `pulsar_*` from the broker's own `:8080/metrics` (`pulsar` job) — a stalled relay shows up as `OutboxRelayStalled` because the heartbeat gauge is only written by the instance that holds the Redis lock. Firing alerts are routed by Alertmanager (http://localhost:9093) per `infra/prometheus/alertmanager.yml` — replace the placeholder Slack webhook URL there to actually receive notifications.

`make up-all` enables every profile. Core is exactly what `GET /api/health` probes (plus mailhog
for the Temporal worker's emails), so `make up` is sufficient for `make dev`, login and the users page.
To start a single profiled service ad-hoc: `docker compose -f infra/docker/docker-compose.yml --profile tools up -d kibana`.

## Docker compose services fail to start / keep restarting

Elasticsearch, Pulsar, ClickHouse, and Flink are memory-hungry. Symptoms: containers exit 137 (OOM-killed), ES stuck "not yet initialized", Pulsar broker restart loop.

- Give Docker Desktop **at least 8 GB** (Settings → Resources); 10–12 GB is comfortable for `up-all`.
- Start only what you need: `make up` (core) instead of `make up-all`.
- ES on Linux may also need `sudo sysctl -w vm.max_map_count=262144`.
- Check the culprit: `docker compose -f infra/docker/docker-compose.yml ps` + `logs <service>`.

## MongoDB replica set not initialized

Transactions (needed by the outbox pattern) require a replica set. Symptom: `Transaction numbers are only allowed on a replica set member`.

```bash
docker compose -f infra/docker/docker-compose.yml exec mongodb \
  mongosh --eval 'rs.initiate()'
# verify
... mongosh --eval 'rs.status().ok'
```

If the volume got into a bad state: `docker compose ... down -v` (wipes data) and start again. Ensure your `MONGODB_URI` includes `replicaSet=rs0` (match `.env.example`) and points at host port **27018** (compose maps `27018:27017`).

## Redis keys "missing" — a local Redis is shadowing the container

Symptom: the backend clearly works (auth/dedup/counters behave), but `docker exec tropis_redis redis-cli ...` shows an empty Redis and keys like `users:total` or `user-processor:seen:*` are nowhere to be found.

Cause: a **local (Homebrew) redis** listening on `127.0.0.1:6379` shadows the docker `tropis_redis` for **host** processes (e.g. `make dev`). macOS resolves `localhost:6379` to `127.0.0.1` first, so the host backend hits the local redis, not the container — while your `docker exec` queries the (empty) container.

```bash
lsof -iTCP:6379 -sTCP:LISTEN -n -P   # shows BOTH a local redis-server and com.docker
redis-cli -h 127.0.0.1 -p 6379 dbsize   # this is where the host backend's keys actually are
brew services stop redis                 # make the docker tropis_redis authoritative, then restart `make dev`
```

## Envoy gRPC-Web CORS errors

Symptom: browser console `CORS policy` / `grpc-status` missing on calls to `localhost:8090`.

- Envoy config (`infra/envoy/`) must allow your frontend origin and expose gRPC-Web headers: `grpc-status`, `grpc-message`, and allow `x-grpc-web`, `content-type`, `authorization`.
- Restart Envoy after config edits: `docker compose ... restart envoy`.
- Verify backend gRPC is actually up on host `:50051` (`nc -z localhost 50051`) — Envoy proxies to the host.
- OPTIONS preflight failing but POST fine ⇒ missing `cors` filter/allowed_methods in envoy.yaml.

## Port conflicts

Notable collisions on this stack: **Aerospike takes 3000/3001**, so the backend runs on **3100** and Grafana is mapped to **3101**. Temporal UI is on 8233, Envoy 8090, Pulsar admin 8080.

```bash
lsof -i :3100        # who owns the port
```

Fix by stopping the other process or changing the host-side mapping in docker-compose.yml / `.env`.

## harbor dev server 500s with `ENOENT .next/routes-manifest.json`

`next dev` and `next build` share the same `.next` directory, so running a
build while the harbor dev server is up pulls the manifest out from under it.
The usual trigger is a repo-wide `pnpm -r build` (or `make build`) in another
terminal, which runs `next build` in `apps/frontend/harbor`.

Symptoms, in order of how far the build got: missing stylesheets
(`GET /_next/static/css/app/layout.css` → 404, page renders unstyled), then
`500` on every route with `ENOENT: .next/routes-manifest.json`.

Fix: stop the dev server, `rm -rf apps/frontend/harbor/.next`, start it again.
To verify harbor's rendered output while builds are running, use the
production output instead (`npm run build && npm start` in that workspace) —
that path does not race with `next dev`.

## A container cannot reach MongoDB, or mongo-express crash-loops

The single-node replica set must advertise `mongodb:27017`, the compose service
name. `mongo-rs-init.js` can only seed `localhost:27017` — the initdb mongod is
bound to loopback, so any other host fails its isSelf check and the container
exits — and a set advertising `localhost` is unusable by any client that
performs topology discovery: it resolves the member to its own container's
loopback and gets `ECONNREFUSED ::1:27017`. `mongo-express` is such a client,
because it drops query options and so cannot be told `directConnection=true`.

The one-shot `mongo-rs-reconfig` service moves the member after mongod is
listening. Check it ran:

```bash
docker logs tropis_mongo_rs_reconfig     # "member now advertises mongodb:27017"
docker exec tropis_mongodb mongosh --quiet --eval 'rs.conf().members[0].host'
```

If the host is still `localhost:27017`, run it again — it is idempotent:

```bash
docker compose -f infra/docker/docker-compose.yml up mongo-rs-reconfig
```

Clients on the **host** are a separate case: `mongodb` is a Docker-network
name that does not resolve outside it, so `MONGODB_URI` keeps
`directConnection=true` and talks to the mapped port (27018) directly.

## pnpm workspace issues

- `Cannot find module '@tropis/shared'` → build it: `pnpm --filter @tropis/shared build`, then reinstall links with `pnpm install`.
- Phantom/nested `node_modules` weirdness → `pnpm install` from the **repo root** only; never `npm install` inside a package.
- Postinstall scripts blocked → this repo whitelists build scripts via `pnpm.onlyBuiltDependencies` (pulsar-client, protobufjs, @nestjs/core…); if a native dep fails, check it's listed there.
- Lockfile mismatch in CI → `pnpm install --frozen-lockfile` locally to reproduce, commit the updated `pnpm-lock.yaml`.

## Vault sealed / token issues

Dev compose runs Vault in **dev mode** (auto-unsealed, root token from compose env) with a `vault-init` container running `infra/vault/init.sh`.

- `Vault is sealed` → the container restarted outside dev mode or init didn't run: `docker compose ... restart vault vault-init`.
- `permission denied` → app token/policy mismatch; compare `VAULT_TOKEN` in backend `.env` with the compose value and `infra/vault/policy.hcl`.
- `connection refused` → check `docker compose ... logs vault` and that port 8200 is mapped.

## Health check returns 503

`GET http://localhost:3100/api/health` aggregates indicators for Mongo, Redis, ClickHouse, PG, ES, MinIO, OPA, Temporal, Pulsar (`src/modules/health/indicators/`). A 503 means at least one dependency is down — the JSON body names it:

```bash
curl -s http://localhost:3100/api/health | jq '.error // .details'
```

Then check that service's container logs. Common causes: ES/Pulsar still warming up (they take 1–2 min), Mongo replica set not initiated, wrong host in `.env` (use `localhost` from host, service names only inside the compose network).
