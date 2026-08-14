# AI Agent Guide

Instructions for AI coding agents (Claude Code, Cursor, Copilot, Codex, etc.)
working in this repository. Human contributors: see [CONTRIBUTING.md](CONTRIBUTING.md).

## What this repo is

A production-grade full-stack starter template (pnpm monorepo): NestJS backend
(gRPC-first), a frontend split by audience — `frontend/helm` (logged-in admin
console, React + Vite SPA, consumes `@tropis/sdk`) and `frontend/harbor` (public
site, Next.js SSR/SSG, full SEO) — event pipeline (MongoDB outbox → Pulsar →
Flink → ClickHouse), Temporal workflows, full observability stack. Architecture
overview: [docs/architecture.md](docs/architecture.md); frontend split &
SEO/rendering: [docs/web-quality.md](docs/web-quality.md).

## Rules you must follow (all CI-enforced)

1. **File placement** — follow the module anatomy in
   [docs/project-structure.md](docs/project-structure.md).
   One-way layering: controllers/processors → services → repositories → schemas.
   Enforced by dependency-cruiser (`pnpm --filter @tropis/backend lint:arch`).
   Rust services follow the Rust service anatomy in the same doc
   (`grpc/ → domain/ → infra/`, compiler-enforced via `pub(crate)` visibility;
   template: `services/rust/signing/`).
   Local CLI dev tooling goes in `devtools/` (never inside apps — see
   [devtools/README.md](devtools/README.md)).
2. **API design** — gRPC is the primary API; REST only for uploads, OAuth
   callbacks, webhooks, health/metrics, SSE/beacon ingest.
   Conventions (tiers, signing, envelope, naming): [docs/api-conventions.md](docs/api-conventions.md).
3. **Proto changes** — add-only; never reuse field numbers; breaking change ⇒
   new version package. Rules: [docs/api-versioning.md](docs/api-versioning.md).
   Enforced by `buf breaking` in CI. Regenerate the SDK with `make proto`.
4. **Which datastore/queue to use for a feature** — decision tables in
   [docs/tech-decisions.md](docs/tech-decisions.md). Do not add new
   infrastructure components without checking it first.
5. **Tests** — bug fixes MUST include a reproducing test first.
   Test pyramid and locations: [docs/testing.md](docs/testing.md).
6. **Commits** — Conventional Commits, scopes enforced by commitlint.
   Full workflow (branch naming, issue refs, releases): [docs/git-workflow.md](docs/git-workflow.md).
7. **New feature module** — follow the step-by-step walkthrough in
   [docs/adding-a-feature.md](docs/adding-a-feature.md); the `user` module is
   the reference implementation.

## Verify before claiming done

Requires Node ≥ 20 (`.nvmrc`).

```bash
# Backend
cd apps/backend && npx tsc --noEmit && npx jest && pnpm lint:arch
# Frontend — helm (admin SPA)
cd frontend/helm && npx tsc -p tsconfig.app.json --noEmit && npx vitest run && pnpm lint:arch && pnpm build
# Frontend — harbor (public Next.js site)
cd frontend/harbor && pnpm typecheck && pnpm lint && pnpm build
# Contracts
npx @bufbuild/buf lint
# Rust services (when touched)
cd services/rust && cargo test --workspace
# Desktop shell (when touched)
cd apps/desktop/src-tauri && cargo check
# Infra (when touched)
docker compose -f infra/docker/docker-compose.yml config --quiet
kubectl kustomize infra/k8s && kubectl kustomize infra/k8s/overlays/prod
# Integration tests (needs Docker)
pnpm --filter @tropis/backend test:int
```

## Do NOT

- Put business logic in controllers, processors, or transformers.
- Import DB/broker drivers (`mongoose`, `ioredis`, `pulsar-client`, `pg`, ...)
  outside `src/infrastructure/` (type-only imports are allowed anywhere).
- Hardcode strings that belong in `constants/` (queue names, event names,
  cache keys, error codes).
- Return schema/entity objects directly from APIs — always map through a
  transformer.
- Commit secrets. `.env` files are gitignored; update `.env.example` when
  adding config.
- Bypass the SDK in the frontend — all API access goes through `@tropis/sdk`.

## Feature workflow docs (docs before code)

Every non-trivial feature has a folder under `docs/workflow/<feature-name>/`
(prd → proposal → contracts → tasks → decisions → acceptance report).
Convention and templates: [docs/workflow/README.md](docs/workflow/README.md).

When working on a feature:

1. **Before touching code**, read its `prd.md`, `proposal-*.md`, and
   `decisions.md` — they explain intent that the code cannot.
2. If the folder doesn't exist and the change warrants one, create it from
   `docs/workflow/_template/` and get the proposal agreed first.
3. Log discoveries in `dev-log/`, decisions in `decisions.md` (append-only),
   progress in `tasks.yaml`. Close with `acceptance-report.md`.
