# Vision

The north star for Tropis: what it is, who it's for, and how every piece earns its place.

## What Tropis is

**A self-hostable product-analytics platform that doubles as a reference for how a modern backend is built.**

- **As a product:** track events, stream-process them in real time, and explore them in live dashboards — a self-hosted PostHog/Mixpanel-lite.
- **As a reference:** every datastore, broker, and tool wired here has a real job in that product, and a live System Map explains why each one is used.

The product gives the stack a purpose. The System Map and docs give it depth.

## The spine: one event's journey

Tropis is event-driven at its core. A single event's path is the whole system's main storyline — every hop uses a real technology, not decoration:

```
ingest (tracking · gRPC/REST, Rust-signed)
  → outbox (reliable publish from MongoDB)
  → event bus (Pulsar / Kafka)
  → stream processing (Flink: windows, funnels, active counts)
  → OLAP read model (ClickHouse)          ← CQRS: write side vs read side
  → analytics API
  → WebSocket → Dashboard (numbers move live)
```

## Layered technology map

Not everything lives on the product's happy path — and that's honest by design. Each tech is tagged by the layer it belongs to.

### 🟢 Core data path — used on every event (the golden path)

| Tech                         | Job                                                         |
| ---------------------------- | ----------------------------------------------------------- |
| tracking (gRPC/REST)         | event ingestion entry                                       |
| Pulsar / Kafka               | event bus — buffering, fan-out                              |
| Flink                        | real-time aggregation (active users, funnels, windows)      |
| ClickHouse                   | event OLAP store + analytics queries                        |
| PostgreSQL                   | users/projects/dashboard config (relational, transactional) |
| Redis                        | cache, event dedup (SET NX), rate limits, BullMQ queues     |
| WebSocket                    | live push to the dashboard                                  |
| React + Vite frontend (helm) | Analytics dashboard + System Map                            |

### 🔵 Feature layer — used when its feature is built

| Tech           | Feature that lights it up                                                                                                                  |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Temporal       | live: the user-onboarding follow-up workflow (durable timer). Next: scheduled reports, data-retention/GDPR workflows, digest orchestration |
| Elasticsearch  | full-text search over raw events / users                                                                                                   |
| Rust (signing) | event payload signing/verification (HMAC) — anti-forgery                                                                                   |
| MongoDB        | raw event payloads / event-store / outbox (volatile shapes)                                                                                |
| Notification   | metric alerts, weekly digest emails                                                                                                        |
| Auth / Vault   | multi-tenant API keys, secret management                                                                                                   |

### 🔧 Ops / delivery layer — how you run and observe the platform, not part of the data flow

| Tech                          | Job                                                            |
| ----------------------------- | -------------------------------------------------------------- |
| Grafana / Prometheus / Jaeger | monitor the platform's own health (surfaced on the System Map) |
| Argo CD / K8s / Helm          | GitOps deployment                                              |
| OPA                           | authorization policy                                           |
| Envoy                         | gRPC-Web gateway                                               |
| MinIO                         | export files / backups                                         |

### ⚪ Demo / reference only — kept to show the pattern, redundant at this scale

| Tech      | Why it's here                                                              |
| --------- | -------------------------------------------------------------------------- |
| Aerospike | the "when Redis runs out of room" KV pattern; overlaps Redis at demo scale |
| pgvector  | only exercised if an AI-insights / similar-users feature is added          |

## The hero: System Map

The signature page. A live architecture diagram where:

- every tech node shows real status + throughput (green = connected, number = live rate),
- data visibly flows along the event's journey,
- layers are color-coded (🟢 core / 🔵 feature / 🔧 ops / ⚪ demo, tagged explicitly),
- each node links to `tech-decisions.md` for the "why this tool here."

One page that serves the product (real data), the reference (explains the architecture), and the goal of showing the whole stack honestly.

## Roadmap

1. **Golden path** — the thinnest end-to-end slice of the event journey: ingest → bus → ClickHouse → WebSocket → one live page.
2. **System Map** — visualize that path as a live diagram (the signature page).
3. **Dashboard** — real analytics: funnels, retention, active users.
4. **Tiered infra** — `core` vs `full` compose profiles + graceful degradation (fixes hard-dependency crash loops; fast, reliable startup).
5. **Feature layer on demand** — build the feature that lights up Temporal / ES / Rust when wanted.

## Principles

- **Layered, not everything-on-the-happy-path.** Core runs; ops is shown; demo-only tech is labeled.
- **Show the whole stack, but honestly.** The System Map exposes everything; tags say what's core vs demo.
- **Event-driven spine.** The event's journey is the storyline; reliability patterns (outbox, CQRS, DLQ) thicken it legitimately.
