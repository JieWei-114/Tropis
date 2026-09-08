# Dev tools — poke anything locally

One-line map from technology → tool → how to open it. This is a _how-to-start_
map, not a feature inventory — each tool's own UI explains the rest. UIs marked
`tools`/`analytics`/`observability` need that compose profile
(`make up-tools`, `make up-analytics`, `make up-obs`); everything else is core
(`make up`) or the app itself (`make dev`).

| Technology          | Tool                         | How                                                                                                                                         |
| ------------------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| REST API            | Swagger UI                   | `make dev` → http://localhost:3100/api/docs                                                                                                 |
| gRPC                | grpcui                       | `make up-tools` (needs the backend up with reflection on — default in dev) → http://localhost:8083                                          |
| gRPC                | grpcurl / Postman            | reflection means no `-proto` flags: `grpcurl -plaintext localhost:50051 list` (Postman gRPC: enable "server reflection")                    |
| Pulsar (browse)     | pulsar-manager               | `make up-tools` → http://localhost:9527                                                                                                     |
| Pulsar (tail/send)  | pulsar-client CLI            | `make pulsar-tail TOPIC=user-events` · `make pulsar-send TOPIC=user-events MSG='{"a":1}'`                                                   |
| WebSocket (/ws)     | ws-listen (devtools/)        | `make ws-listen [TOKEN=<jwt>]` — prints every Socket.io event live (auto-logs-in as the seeded editor `admin@example.com`)                  |
| Outbox              | outbox-status (devtools/)    | `make outbox-status` — counts by status + oldest pending/failed rows                                                                        |
| SDK (@tropis/sdk)   | interactive REPL (devtools/) | `make sdk-repl` — `api` facade preloaded + logged in; try `await api.fetchUsers()`                                                          |
| Temporal            | Temporal Web UI              | `make up-tools` → http://localhost:8233 · `make wf-demo` runs the onboarding workflow end-to-end (`CRASH=1` for the crash-recovery variant) |
| Flink               | Flink Web UI                 | `make up-analytics` → http://localhost:8081                                                                                                 |
| Email               | MailHog                      | `make up` → http://localhost:8025                                                                                                           |
| Redis               | RedisInsight                 | `make up-tools` → http://localhost:5540                                                                                                     |
| MongoDB             | mongo-express                | `make up-tools` → http://localhost:8085                                                                                                     |
| ClickHouse          | CH-UI / Metabase             | `make up-tools` → http://localhost:8124 (CH-UI) · http://localhost:3200 (Metabase)                                                          |
| Elasticsearch       | Kibana                       | `make up-tools` → http://localhost:5601                                                                                                     |
| Tracing             | Jaeger                       | `make up-obs` → http://localhost:16686                                                                                                      |
| Metrics             | Grafana                      | `make up-obs` → http://localhost:3101                                                                                                       |
| Containers/logs     | Dozzle                       | `make up-tools` → http://localhost:9999                                                                                                     |
| Load testing        | k6                           | `make load-test` (stack must be up + seeded — see load/README.md)                                                                           |
| PostgreSQL          | pgAdmin                      | `make up-tools` → http://localhost:5050 (server mode off — no login)                                                                        |
| Object storage      | MinIO Console                | `make up` → http://localhost:9902 (minioadmin / minioadmin123)                                                                              |
| Secrets             | Vault UI                     | `make up` → http://localhost:8200 (dev root token: `dev-root-token`)                                                                        |
| Policy (authz)      | OPA REST API                 | `make up` → http://localhost:8181 — e.g. `curl -d '{"input":{}}' localhost:8181/v1/data/authz/allow`                                        |
| Alerting            | Alertmanager                 | `make up-obs` → http://localhost:9093                                                                                                       |
| BullMQ queues + DLQ | Bull Board                   | `make dev` → http://localhost:3100/api/queues — inspect/retry jobs and replay `dead-letter` jobs                                            |
| Admin role          | promote-admin script         | `make promote-admin EMAIL=admin@example.com` — `make seed` creates an `editor`; this grants `admin` (then re-login)                         |

Notes:

- Custom CLI tools live in `devtools/` — add new ones there (see
  [devtools/README.md](../devtools/README.md)).
- **gRPC reflection** is what powers grpcui/grpcurl discovery. It is on
  automatically when `NODE_ENV != production` and gated off in production
  (opt back in with `GRPC_REFLECTION=true`) — see
  `apps/backend/src/config/grpc-reflection.ts` for the rationale. The internal
  listener (:50061) shares the same gate: `grpcurl -plaintext localhost:50061 list`.
- The `grpcui` container targets the backend on the _host_
  (`host.docker.internal:50051`), so start the backend (`make dev`) before —
  or restart the container after — bringing up the tools profile.
