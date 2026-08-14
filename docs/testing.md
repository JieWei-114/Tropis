# Testing

## Test pyramid

```
        /  E2E  \          full docker compose stack + Playwright — before merge
       / Integr. \         Testcontainers against real deps — per PR
      /   Unit    \        mocked deps, fast — pre-push + every CI run
```

| Level           | Where                                                                                                          | Deps                                       | When it runs                                   |
| --------------- | -------------------------------------------------------------------------------------------------------------- | ------------------------------------------ | ---------------------------------------------- |
| **Unit**        | in-module `__tests__/` (`*.spec.ts`)                                                                           | All mocked                                 | every CI run (`pnpm -r test` / `make test`)    |
| **Integration** | `apps/backend/test/integration/` (`*.integration.spec.ts`, `jest-integration.json`)                            | Real Mongo/Redis/PG via **Testcontainers** | Per PR (CI `integration` job; `make test-int`) |
| **E2E**         | `apps/backend/test/` (`app.e2e-spec.ts`, `jest-e2e.json`) + Playwright browser flows in `e2e/` (`@tropis/e2e`) | Full compose stack                         | Before merge (CI `e2e` job; `make test-e2e`)   |

Above the pyramid sits the **manual-testing gap** the automation can't close —
exploratory checks, cross-browser quirks, offline behavior, concurrent edits.
Each feature's workflow folder covers it with a copy of
[`docs/workflow/_template/qa-checklist.md`](workflow/_template/qa-checklist.md)
(smoke, boundary, regression scope, cross-browser/viewport, sign-off).

## Unit tests

- Test **services and utils** — that's where the logic is. Controllers/transformers get thin sanity tests.
- Mock everything injected (repositories, queue, pulsar). Example pattern from `modules/user/__tests__/user.service.spec.ts`: provide mock repositories via NestJS `Test.createTestingModule`.

```ts
// modules/feature/__tests__/feature.service.spec.ts
const repo = { findById: jest.fn() };
const module = await Test.createTestingModule({
  providers: [FeatureService, { provide: FeatureRepository, useValue: repo }],
}).compile();
```

## Integration tests

Real infrastructure, isolated per test run:

```ts
import { MongoDBContainer } from '@testcontainers/mongodb';
const mongo = await new MongoDBContainer('mongo:7').start();
process.env.MONGODB_URI = mongo.getConnectionString();
```

Use these to verify repositories (queries, indexes, transactions with the outbox) — the layer unit tests can't cover honestly.

Run: `pnpm --filter @tropis/backend test:int` (or `make test-int`). The suite lives under `apps/backend/test/integration/` (`auth`, `outbox`, `repository` specs) and needs only Docker.

## E2E

`make test-e2e` brings up the compose stack, runs the Jest E2E suite (`test:e2e`), then builds/starts backend + frontend preview and runs the Playwright flows in `e2e/tests/` (login, create user, see it in the table, analytics smoke). The **E2E smoke set doubles as the regression suite** — it must stay fast enough to run before every merge.

### Multi-browser E2E

The Playwright suite runs **Chromium only by default** so CI stays fast. Set
`E2E_ALL_BROWSERS=1` to add Firefox + WebKit projects (3× the tests — use for
pre-release cross-browser passes, not every PR):

```bash
cd e2e && E2E_ALL_BROWSERS=1 npx playwright test   # install engines once: npx playwright install firefox webkit
```

## Load testing

k6 scenarios live in `load/scenarios/` (see [`load/README.md`](../load/README.md)):
`health.js` (GET `/api/health` baseline, p95 < 200ms), `track-ingest.js`
(POST `/api/v1/track` batch ingest, ramp 0→50 VUs, p95 < 200ms) and `login.js`
(POST `/api/auth/login`, p95 < 500ms — bcrypt). All enforce
`http_req_failed rate < 1%`; a breached threshold makes k6 exit non-zero.

Run `make load-test` (docker `grafana/k6`; **the stack must be up** — `make up`,
backend on :3100, `make seed`). Never point these at production.

## Regression strategy

1. **Bug-first-repro-test rule**: every bug fix PR MUST contain a test that fails before the fix and passes after. No repro test, no merge (see CONTRIBUTING.md).
2. **E2E smoke set** = the regression suite for whole-system behavior.
3. **Contract tests**:
   - Proto compatibility: `buf breaking` in CI against `main` — field removals/renumbering fail the build.
   - REST: snapshot tests of response shapes for `/api/v1` endpoints.
   - Event payloads: snapshot the `AppEvent` shapes in `packages/shared/src/events/` — add-only.

## Coverage philosophy

**80%+ on `services/` and `utils/`** is the target, not vanity global numbers. Jest currently collects coverage only from `*.service.ts` / `*.gateway.ts` / `*.repository.ts` and enforces 70% lines/statements, 60% branches/functions (see `apps/backend/package.json`). A repo-wide number that comes from testing DTOs and module wiring is worthless; a tested service layer is not. `pnpm --filter @tropis/backend test:cov` to check.

## Commands

```bash
make test        # unit tests, all packages
make test-int    # backend integration suite (Testcontainers, Docker only)
make test-e2e    # full-stack e2e (compose up + suite)
```
