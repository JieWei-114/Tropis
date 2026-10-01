# Tropis

Tropis (τρόπις) — the keel. The foundation every product is built on.

Tropis provides the capabilities a product needs underneath its features —
authentication, users, tenancy, a transactional outbox and event bus,
datastores, background jobs and durable workflows, realtime push,
observability, security fences and CI-enforced layering — as one runnable
pnpm monorepo. A product-analytics slice ships with it as the reference
workload that exercises those capabilities end to end.

## What is inside

| Part                    | Location                                      | What it is                                                                                                                                |
| ----------------------- | --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Backend                 | `apps/backend/`                               | NestJS — RPC first (Connect), REST for the listed exceptions, Socket.IO for realtime; runs as public, private, worker and scheduler roles |
| helm (the console)      | `apps/frontend/helm/`                         | React + Vite SPA, talks to the backend via `@tropis/sdk`                                                                                  |
| Public site             | `apps/frontend/harbor/`                       | Next.js App Router, server-rendered, SEO                                                                                                  |
| Desktop / mobile shells | `apps/desktop/`, helm's `android/` and `ios/` | Tauri and Capacitor wrappers around the console build                                                                                     |
| Contracts               | `proto/`                                      | Protobuf contracts, add-only, gated by `buf breaking`                                                                                     |
| Shared code             | `packages/`                                   | `@tropis/shared` (types, events, error codes), `@tropis/sdk` (client)                                                                     |
| Non-Node services       | `services/`                                   | Non-Node code by runtime: `rust/` (gRPC services, e.g. `signing`), `flink/` (stream jobs, e.g. event bus → analytics store)               |
| Infrastructure          | `infra/`                                      | Docker Compose, Kubernetes, and per-tool configuration                                                                                    |

How the pieces fit together: [docs/architecture.md](docs/architecture.md).

## Quickstart

Prerequisites: Docker, Node.js ≥ 22 (`.nvmrc`), pnpm 10 (`corepack enable`).
Rust, Android Studio and Xcode are only needed for the native services and
shells. Details: [docs/development.md](docs/development.md#setup).

```bash
nvm use                                      # Node version from .nvmrc
make install                                 # pnpm install + .env files from the examples
make up                                      # core containers + the capabilities the backend needs
make dev                                     # backend, every role in one process (:3100 HTTP, :50051 RPC) + console (:5173)
# in a second terminal, once make dev is up:
make seed                                    # tenant dev, admin@example.com as admin, demo users, sample analytics events
```

Open http://localhost:5173 and log in with `admin@example.com` /
`Password123!` (tenant `dev`, the console's default). The Analytics page shows the seeded events and the Users page
lists the seeded users. If something fails:
[docs/development.md](docs/development.md#troubleshooting).

`make help` lists every target. Optional groups of containers (stream
processing, observability, admin UIs, the Rust service) are compose profiles:
[docs/development.md](docs/development.md#compose-profiles).

## Documentation

| Doc                                                      | Owns                                                               |
| -------------------------------------------------------- | ------------------------------------------------------------------ |
| [docs/architecture.md](docs/architecture.md)             | What the foundation is and how the pieces fit                      |
| [docs/project-structure.md](docs/project-structure.md)   | Where code goes, layering rules, adding a module, feature docs     |
| [docs/tech-decisions.md](docs/tech-decisions.md)         | Which technology does which job, when not to use it, degradation   |
| [docs/api-conventions.md](docs/api-conventions.md)       | API rules, tiers, signing, errors, versioning, API reference       |
| [docs/development.md](docs/development.md)               | Local setup, commands, ports, env vars, dev tools, troubleshooting |
| [docs/deployment.md](docs/deployment.md)                 | Images, Kubernetes, GitOps, secrets, native distribution           |
| [docs/testing.md](docs/testing.md)                       | Test pyramid, where tests live, coverage                           |
| [docs/security-checklist.md](docs/security-checklist.md) | Pre-launch security checklist                                      |
| [docs/web-quality.md](docs/web-quality.md)               | SEO, performance, accessibility, PWA                               |
| [docs/tracking-plan.md](docs/tracking-plan.md)           | Tracked event registry and naming                                  |
| [CONTRIBUTING.md](CONTRIBUTING.md)                       | Branches, commits, pull requests, CI, releases                     |
| [AGENTS.md](AGENTS.md)                                   | Rules and verification commands for AI coding agents               |
| [SECURITY.md](SECURITY.md)                               | Reporting a vulnerability                                          |

Every product feature built on the foundation (`apps/backend/src/features/`)
has one entry in [docs/project-structure.md](docs/project-structure.md#feature-documentation):
what it owns, how to remove it, and the coupling removal still touches.

## License

[MIT](LICENSE)
