# Testing

## Test pyramid

```
          /  Load  \        k6 against a running stack — on demand
         /   E2E    \       full stack: Jest E2E + Playwright — every CI run
        / Integration\      Testcontainers against real deps — every CI run
       /     Unit     \     mocked deps, fast — every CI run
```

| Level           | Where                                                                                                                                                                                                                                                    | Deps                                                | Proves                                                                             | Runs                                                                     |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| **Unit**        | `__tests__/` next to the code (`*.spec.ts` in the backend, `*.test.ts(x)` in helm (the console), harbor and the SDK, `*.test.mjs` in shared); Rust in-crate                                                                                              | All mocked or in-memory                             | Business logic in services, guards, gateways, processors, components               | `make test`; CI `backend`, `frontend`, `harbor`, `sdk` and `shared` jobs |
| **Integration** | `apps/backend/test/integration/` (`*.integration.spec.ts` and `*.conformance.spec.ts`, `test/jest-integration.json`; a product feature's suites in `test/integration/features/<feature>/`, the only place under `test/` that may import `src/features/`) | Real datastores and brokers in throwaway containers | Repositories, the outbox, auth, the graph projection, and every capability adapter | `make test-int`; CI `integration` job                                    |
| **E2E**         | `apps/backend/test/app.e2e-spec.ts` (`test/jest-e2e.json`) and Playwright flows in `e2e/tests/` (`@tropis/e2e`)                                                                                                                                          | Full compose stack                                  | HTTP, ops-port and RPC surfaces, and user-facing flows in a browser                | `make test-e2e`; CI `e2e` job                                            |
| **Load**        | `load/scenarios/` (k6)                                                                                                                                                                                                                                   | Running stack                                       | Latency and error-rate budgets under concurrency                                   | `make load-test`; not in CI                                              |

Unit test placement follows the rules in [project-structure.md](project-structure.md).

## Manual testing

Automation does not cover exploratory checks, cross-browser quirks (Playwright runs Chromium only by default), offline and PWA behavior, the native shells on real devices, or concurrent edits by several users. Before a release, do a manual pass:

- a smoke run through the main flows;
- boundary cases of the changed inputs;
- the regression scope of the change (the screens and flows it touches);
- one Firefox and WebKit run via `E2E_ALL_BROWSERS=1` (see [Multi-browser](#multi-browser));
- a mobile viewport.

Record what you checked in the PR's **test evidence**, so the reviewer knows what was covered by hand and what was not.

## Unit tests

Where they live:

| Workspace               | Runner                  | Location                                                                                                                                   |
| ----------------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `apps/backend`          | Jest (`ts-jest`)        | `src/**/__tests__/*.spec.ts` (modules, `common/guards`, `infrastructure/*`, `config`); one exception: `src/config/grpc-reflection.spec.ts` |
| `apps/frontend/helm`    | Vitest, jsdom           | `src/**/__tests__/*.test.ts(x)` (Testing Library, setup in `src/setupTests.ts`)                                                            |
| `apps/frontend/harbor`  | Vitest, jsdom           | `**/__tests__/*.test.ts(x)` (`vitest.config.mts`)                                                                                          |
| `packages/sdk`          | `tsc --noEmit` + Vitest | `src/**/__tests__/*.test.ts`                                                                                                               |
| `packages/shared`       | `tsc` + `node --test`   | `src/**/__tests__/*.test.mjs` (error catalog, event envelope)                                                                              |
| `services/rust/signing` | `cargo test`            | `#[cfg(test)]` modules in `src/` and `tests/` (run from the repo root, the Cargo workspace)                                                |

Rules:

- Test **services and utils**: that is where the logic is. Controllers, DTOs and transformers get thin sanity tests.
- Mock everything injected (repositories, queue, Pulsar, Redis, ClickHouse), so unit tests are fast and fail only for the unit's own logic. Build the module with NestJS `Test.createTestingModule` and provide mocks with `useValue`, as in `apps/backend/src/modules/user/__tests__/user.service.spec.ts`:

```ts
// modules/feature/__tests__/feature.service.spec.ts
const repo = { findById: jest.fn() };
const module = await Test.createTestingModule({
  providers: [FeatureService, { provide: FeatureRepository, useValue: repo }],
}).compile();
```

- The request-signing HMAC test vector is shared across three suites: the backend guard (`common/guards/__tests__/signature.guard.spec.ts`), the SDK (`packages/sdk/src/signing/__tests__/signing.test.ts`) and the Rust signing service. The rule for changing it: [api-conventions.md](api-conventions.md#request-signing-server-to-server-rest).

## Integration tests

Real infrastructure, isolated per suite. MongoDB and Redis start through Testcontainers modules; every other image (Kafka, Pulsar, Neo4j, Aerospike, PostgreSQL with pgvector, Elasticsearch, ClickHouse, OPA, MinIO, Mailpit) through the small docker-CLI runner in `test/integration/containers.ts`, which publishes random `127.0.0.1` ports and removes each container on stop and on process exit. Images whose `latest` tag moves under the suite are pinned to an exact version in their spec: `pgsty/minio:RELEASE.2026-08-04T00-00-00Z` (official MinIO images are not published; MinIO is a local and test stand-in only, see [deployment.md](deployment.md)), `openpolicyagent/opa:1.20.1`, `aerospike/aerospike-server:8.1.2.4` and `axllent/mailpit:v1.31.3`.

```ts
import { MongoDBContainer } from '@testcontainers/mongodb';
const mongo = await new MongoDBContainer('mongo:7').start();
process.env.MONGODB_URI = mongo.getConnectionString();
```

Suites:

- `auth`, `outbox`, `repository` and `membership-graph` (`*.integration.spec.ts`): queries, indexes, transactions with the outbox and the graph projection, which unit tests cannot cover honestly.
- One conformance suite per capability adapter (`*.conformance.spec.ts`): cache, dedup, documents, kv (Redis and Aerospike), lock, ratelimit, realtime, messaging (Pulsar and Kafka), graph, jobs, objects, olap, policy, relational (tenant fences under RLS), search, vector, mail, signing, workflow (a Temporal dev server, `temporal server start-dev`; no worker polls the conformance queue, so executions stay running and visibility queries are polled until they catch up) and secrets (a Vault dev server with KV v2 and Transit). The policy suite runs against OPA without authentication and with token authentication (right, wrong and missing token).

### Capability conformance

Each capability defines its contract once, as a shared suite in `src/infrastructure/<capability>/__tests__/<capability>.conformance.ts` (`describe<Capability>Port`). `test/integration/<capability>.conformance.spec.ts` runs it against each real adapter, and where an in-memory fake or local adapter exists (cache, dedup, kv, lock, ratelimit, messaging, realtime, search, vector, signing, workflow over an in-memory Temporal client, secrets over the env adapter and an in-memory Vault client) the unit spec next to the suite runs it against that too, so every adapter proves the same behavior and a new adapter is done when the suite passes against it.

The suite needs only Docker. It runs serially (`--runInBand`, `maxWorkers: 1`) with a 240 s per-test timeout. When Docker is not available, `test/integration/docker.ts` skips each suite with a warning instead of failing, so a green local run without Docker proves nothing. The native signing conformance suite also skips with a warning unless the Rust binary exists (`cargo build -p signing`, `target/debug/signing`); the CI `integration` job builds it first.

## E2E tests

### Jest E2E (backend)

`apps/backend/test/app.e2e-spec.ts` boots the whole `AppModule` (every role) against real infrastructure, with the same `ValidationPipe` and `setGlobalPrefix('api')` as the entry point but not its exception filter, helmet or raw-body parser. It starts the ops server and the RPC listeners itself on ephemeral ports, registers tenant `e2e` in the tenant directory (self sign-up on), registers a user in it and grants it admin, then checks:

- HTTP: `GET /api/health` answers, and `GET /api/metrics` is not served on the public port;
- ops port: `/livez`, `/readyz` and Prometheus text on `/metrics`;
- RPC: `grpc.health.v1.Health/Check` reports `SERVING`; `AuthService/Login` returns `UNAUTHENTICATED` for bad or empty credentials and `INVALID_ARGUMENT` without a tenant; `UserService/FindAll` rejects a call without a token and returns a page for the admin.

It needs the `make up` stack running.

### Playwright (browser)

`e2e/tests/` covers helm (the console) end to end:

| Spec                   | Proves                                                                     |
| ---------------------- | -------------------------------------------------------------------------- |
| `smoke.spec.ts`        | App loads, navigation and deep links work, unauthenticated users see login |
| `auth.spec.ts`         | Register, sign in, bad password, client-side validation, unknown user      |
| `users.spec.ts`        | Create, search, edit and delete a user through the UI                      |
| `analytics.spec.ts`    | Firing an event updates the live feed and stats                            |
| `quality.spec.ts`      | Every page renders in both themes with no console errors; i18n is applied  |
| `responsive.spec.ts`   | Every page fits and stays usable at every width                            |
| `native-shell.spec.ts` | Safe-area insets, visible-viewport height and soft-keyboard handling       |

The Playwright config (`e2e/playwright.config.ts`) starts no servers: the backend must be on `http://localhost:3100` and the frontend on `E2E_BASE_URL` (default `http://localhost:5173`, served by `vite preview`). Tests run serially with one worker and one retry, because the flows share backend state. Every test signs in through the UI (`loginAsAdmin` / `login` in `e2e/tests/helpers.ts`): the session is an in-memory access token plus the httpOnly refresh cookie, so it cannot be captured once and replayed into storage.

`make test-e2e` does the whole thing: compose up (the `make up` profiles) and wait until every service is healthy (`up --wait`, at most `COMPOSE_WAIT_TIMEOUT`, 300 s), run the migrations (`migrate:up`), Jest E2E, build and start the backend, wait for `http://localhost:9464/readyz` (at most 180 s), seed and promote `admin@example.com`, start the helm preview, run Playwright (20-minute `globalTimeout` in `e2e/playwright.config.ts`), tear everything down. An `EXIT` trap stops the backend, the preview and the stack on every exit, including a failed step or Ctrl-C, and prints the backend log tail on failure. It starts the backend with `RATE_LIMIT_AUTH=$(E2E_RATE_LIMIT_AUTH)` (default 200) and both sign-up limits at `$(E2E_SIGNUP_RATE_LIMIT)` (default 1000, both set in the `Makefile`), because the suite makes many real sign-ins and sign-ups from one address and the default limits would reject them. When you run Playwright against a backend you started yourself, start it with raised `RATE_LIMIT_AUTH`, `SIGNUP_RATE_LIMIT_IP` and `SIGNUP_RATE_LIMIT_TENANT` for the same reason. The E2E set is the regression suite for whole-system behavior, so it must stay fast enough to run on every PR.

### Multi-browser

Playwright runs **Chromium only** by default so CI stays fast. `E2E_ALL_BROWSERS=1` adds Firefox and WebKit (three times the tests); use it for cross-browser passes, not every PR:

```bash
cd e2e && npx playwright install firefox webkit   # once
cd e2e && E2E_ALL_BROWSERS=1 npx playwright test
```

## Load tests

k6 scenarios in `load/scenarios/` (`health.js`, `track-ingest.js`, `login.js`) hold latency and error thresholds on the REST fast paths; a breached threshold makes k6 exit non-zero. `make load-test` runs all three through the `grafana/k6` Docker image against a running stack and refuses to start if `/api/health` is not healthy. Never point them at production. Scenarios, thresholds and options: [`load/README.md`](../load/README.md).

## Coverage

Coverage measures the layers where logic lives, not a repo-wide vanity number. A number earned by testing DTOs and module wiring is worthless; a tested service layer is not.

| Workspace            | Collected from                                                       | Enforced floor                                         | Where enforced                                                                                               |
| -------------------- | -------------------------------------------------------------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| `apps/backend`       | `*.service.ts`, `*.gateway.ts`, `*.repository.ts` (excluding `gen/`) | lines 50%, statements 50%, branches 45%, functions 35% | `jest.coverageThreshold` in `apps/backend/package.json`; fails the CI `backend` job (`pnpm test --coverage`) |
| `apps/frontend/helm` | all sources (v8 provider)                                            | none                                                   | Reported only (`pnpm test:coverage` in the CI `frontend` job)                                                |

The backend floor sits just below the measured coverage to catch regressions. Raise it as tests are added; never lower it. SonarCloud reads the backend LCOV report (`apps/backend/coverage/lcov.info`) for its quality gate; see [CONTRIBUTING.md](../CONTRIBUTING.md#sonarcloud).

Check locally with `pnpm --filter @tropis/backend test:cov`.

## Regression and contract rules

1. **Bug fixes start with a reproducing test**, so the fix is proven and the bug cannot return unnoticed. Every bug-fix PR contains a test that fails before the fix and passes after. No repro test, no merge. The bug report template and the PR checklist both require it.
2. **The E2E set is the whole-system regression suite.**
3. **Proto contracts**: the CI `proto` job runs `buf lint`, and on pull requests `buf breaking` against `main`, so field removals and renumbering fail the build. It also regenerates `packages/sdk/src/gen` and fails if the committed code differs.
4. REST response shapes and event payloads have no automated contract check; changes to them follow [api-conventions.md](api-conventions.md).

## Commands

```bash
make test        # unit tests in every workspace (pnpm -r test: backend Jest, helm, harbor, SDK, shared)
make test-int    # backend integration suite (Testcontainers, Docker only)
make test-e2e    # full stack: compose up, Jest E2E, Playwright, teardown
make rust-test   # Rust: fmt check, clippy, cargo test
make load-test   # k6 scenarios against a running stack

# Backend (from apps/backend, or with --filter @tropis/backend)
pnpm test        # Jest unit tests
pnpm test:cov    # with coverage and threshold check
pnpm test:watch
pnpm test:int    # integration suite
pnpm test:e2e    # Jest E2E (infrastructure must be running)

# Frontend (from apps/frontend/helm or apps/frontend/harbor)
pnpm test        # Vitest, run once
pnpm test:watch
pnpm test:coverage   # helm only

# Browser E2E (repo root; backend and frontend must be running)
pnpm test:e2e        # Playwright
pnpm test:e2e:ui     # Playwright UI mode
```
