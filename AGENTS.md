# AI Agent Guide

Instructions for AI coding agents (Claude Code, Cursor, Copilot, Codex, etc.)
working in this repository. Human contributors: see [CONTRIBUTING.md](CONTRIBUTING.md).

## What this repo is

A foundation that products are built on (pnpm monorepo). It provides the
capabilities — authentication, users, tenancy, the transactional outbox and
event bus, datastores, background jobs and durable workflows, realtime push,
observability, security fences and CI-enforced layering — and ships product
features (analytics, tracking, membership graph) as the reference workload
that exercises them. In the backend the foundation is `src/infrastructure/`,
`src/common/` and `src/modules/`; product features are `src/features/`, each
removable by deleting its folder and its imports in the role roots
([project-structure.md](docs/project-structure.md#foundation-and-features)).

NestJS backend (RPC-first, served with Connect), two frontends split by audience — helm (the
console, `apps/frontend/helm`, React + Vite SPA, consumes `@tropis/sdk`) and
harbor (the public site, `apps/frontend/harbor`, Next.js SSR/SSG) — and
non-Node services under `services/`. How it fits together:
[docs/architecture.md](docs/architecture.md). Which doc owns which topic:
[README.md](README.md#documentation).

## Rules

### Enforced by tooling — a violation fails the build

1. **Import boundaries** — dependency-cruiser (`pnpm lint:arch`, run in the
   backend, helm and harbor CI jobs) blocks:
   - runtime circular dependencies;
   - the foundation depending on what is built on it: `infrastructure/`,
     `common/` or `config/` importing `modules/` or `features/`, a
     foundation module importing a product feature, a feature importing
     another feature, or a feature reaching a foundation module past its
     public surface (`*.module.ts`, `services/`, `constants/`,
     `interfaces/`, `dto/`);
   - `controllers/`, `gateways/` and `processors/` importing `repositories/`
     or `schemas/`; any unit importing another's `repositories/`,
     `schemas/` or `event-store/`;
   - a backend role root (`src/roles/<role>/`) reaching what that role does
     not run: controllers, gateways or the RPC server from the worker or
     scheduler, processors, jobs, workflows, crons or the relay from public,
     anything but internal RPC from private; `@nestjs/schedule` outside
     `*.schedule.ts` and the scheduler root;
   - runtime imports of driver packages (`ioredis`, `pulsar-client`, `pg`,
     `bullmq`, `socket.io`, `@temporalio/*`, …) outside
     `src/infrastructure/<capability>/adapters/` and
     `src/infrastructure/connections/`, except `mongoose`/`@nestjs/mongoose`
     in a unit's persistence folders and module files and in the outbox, and
     `@temporalio/workflow` in `*.workflow.ts`; business code importing an
     adapter or a connection instead of the capability port; any `*.port.ts`
     importing driver types;
   - in helm and harbor: cross-feature imports, deep imports into a feature,
     and the composition-root rules.

   The full rule table and the reason for each exemption:
   [docs/project-structure.md](docs/project-structure.md).

2. **Contracts** — proto changes are add-only; never reuse a field number; a
   breaking change is a new version package, because published clients keep
   decoding the old wire format. `buf lint` runs on every CI run and
   `buf breaking` on pull requests. Regenerate the SDK with `make proto`.
   Rules: [docs/api-conventions.md](docs/api-conventions.md#versioning-and-compatibility).
3. **Logging** — backend ESLint rejects `console.*` and Nest's `Logger`;
   module code logs through `createLogger()` from
   `src/common/observability/logger.ts` with an explicit event name, so every
   record carries the trace id, redaction and one shape.
4. **Types, tests, build, formatting** — CI runs `tsc`, the backend
   (unit and integration), helm, harbor and SDK test suites, the builds, and
   `prettier --check .`. Job list: [CONTRIBUTING.md](CONTRIBUTING.md#ci-checks).

### Followed by convention — reviewers check these

5. **Module anatomy and layering direction** — controllers/processors →
   services → repositories → schemas, following the module anatomy in
   [docs/project-structure.md](docs/project-structure.md), so storage can
   change without touching the transport. dependency-cruiser checks only the
   boundaries in rule 1; folder layout and `services/` → `schemas/` are
   review-only. Rust services follow `grpc/ → domain/ → infra/`: `pub(crate)`
   keeps `domain` and `infra` out of the crate's public API, but the direction
   inside the crate is review-only.
6. **API design** — RPC (Connect, from the proto contracts) is the primary
   API, because one proto contract generates both the server types and the
   SDK. REST only for the exceptions listed in
   [docs/api-conventions.md](docs/api-conventions.md#transport-choice);
   anything else is an RPC method.
7. **Choosing a datastore or queue** — use the decision tables in
   [docs/tech-decisions.md](docs/tech-decisions.md); do not add an
   infrastructure component without checking it first, so each job has one
   owner.
8. **Bug fixes start with a reproducing test**, so the fix is proven and the
   bug cannot return unnoticed. [docs/testing.md](docs/testing.md).
9. **Commits** — Conventional Commits with the scopes in
   `.commitlintrc.json`. The commit-msg hook reports violations but does not
   block: release-please reads the squash-merged PR title, so that title is
   what reviewers check. Delivery chain:
   [CONTRIBUTING.md](CONTRIBUTING.md#delivery-chain).
10. **New module** — follow the walkthrough in
    [docs/project-structure.md](docs/project-structure.md#adding-a-backend-module--step-by-step);
    the `user` module is the reference implementation. A product feature goes
    in `src/features/`, plugs into the foundation only by registering (queues
    with `JobsModule.forFeature`, workflows with `WorkflowModule.forFeature`,
    permissions with `@Authorize`, metrics as its own providers) and imports
    the capability modules it injects.
11. **Dev tooling** — local CLI tools go in `devtools/`, never inside an app,
    so apps ship no dev-only code. [devtools/README.md](devtools/README.md).

## Documentation

- Docs state what the code **is**, the rules, and why each rule exists.
  They never narrate history — git holds that.
- Change the doc in the same change as the code it describes. Merge into
  the doc that owns a topic rather than adding a new file.
- Every product feature has one entry in
  [project-structure.md → Feature documentation](docs/project-structure.md#feature-documentation)
  (what it owns, how to remove it, the coupling removal still touches; a
  temporary feature also states its end date and teardown). There are no
  per-feature README files.
- **Before changing a product feature, read its entry** and the doc sections
  it links — they record intent the code cannot show.
- **Contracts first** — a feature that adds or changes a proto RPC, REST
  endpoint, event payload or DB schema has that contract reviewed before the
  implementation, because a merged contract is add-only.

Rules for feature docs:
[docs/project-structure.md](docs/project-structure.md#feature-documentation).

## Verify before claiming done

Requires Node ≥ 22 (`.nvmrc`). Run each line from the repository root.
`@tropis/shared` resolves to its build output, so build it first on a fresh
clone — otherwise the backend and helm type checks cannot find it.

```bash
pnpm install && pnpm --filter @tropis/shared build
# Backend
(cd apps/backend && npx tsc --noEmit && npx jest && pnpm lint:arch)
# helm (the console)
(cd apps/frontend/helm && npx tsc -p tsconfig.app.json --noEmit && npx vitest run && pnpm lint:arch && pnpm build)
# harbor (the public site)
(cd apps/frontend/harbor && pnpm typecheck && pnpm lint && pnpm lint:arch && pnpm test && pnpm build)
# Contracts
npx @bufbuild/buf lint
# Formatting (whole repo, as CI runs it)
npx prettier --check .
# Rust services (when touched)
cargo test --workspace
# Desktop shell (when touched) — Tauri checks that helm's build output exists
pnpm --filter @tropis/helm build && (cd apps/desktop/src-tauri && cargo check)
# Infra (when touched)
docker compose -f infra/docker/docker-compose.yml config --quiet
kubectl kustomize infra/k8s && kubectl kustomize infra/k8s/overlays/staging && kubectl kustomize infra/k8s/overlays/prod
# Integration tests (needs Docker)
pnpm --filter @tropis/backend test:int
```

## Do NOT

- Put business logic in controllers, processors, or transformers — the
  transports stay thin, so logic is unit-testable and shared by REST and gRPC.
- Hardcode strings that have an owner — queue definitions, topics and event
  names live in the module's `constants/` (an event two units share in
  `@tropis/shared`), cache/kv/lock keys come from the keyspace builders
  (`src/common/keyspace`), error codes from the catalog in `@tropis/shared`
  — one place to rename, and no copies that drift apart through a typo.
- Return schema/entity objects directly from APIs — always map through a
  transformer, because schemas carry internal fields (`_id`, `__v`,
  `passwordHash`).
- Commit secrets. `.env` files are gitignored; update `.env.example` when
  adding config. Git history is permanent and readable by anyone with the
  repository.
- Bypass the SDK in helm — all API access goes through `@tropis/sdk`, which
  owns token refresh, request signing and error mapping. A harbor feature
  that needs backend data adds the SDK and wires it in `lib/`.
