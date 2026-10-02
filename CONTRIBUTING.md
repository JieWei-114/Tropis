# Contributing

## Before your first PR

- Local setup and troubleshooting: [docs/development.md](docs/development.md).
- Where code goes and how it is named: [docs/project-structure.md](docs/project-structure.md).
- How to test and what coverage is enforced: [docs/testing.md](docs/testing.md).
- Every product feature built on the foundation (`apps/backend/src/features/`) has one entry in [docs/project-structure.md#feature-documentation](docs/project-structure.md#feature-documentation) (what it owns, how to remove it); foundation behaviour is documented in the doc that owns the topic under `docs/`.
- Read a feature's entry before changing the feature, and have its contracts (API shapes, events, data it owns) reviewed before implementation, so design problems surface before code is written. Same rules: [docs/project-structure.md#feature-documentation](docs/project-structure.md#feature-documentation).

## Delivery chain

Every change travels the same path, from issue to production:

```
Issue (#123) ──► branch feat/123-… ──► conventional commits ──► PR (squash) ──► main
                                                                                  │
                              release-please accumulates commits ◄───────────────┘
                                        │
                             release PR (version bump + CHANGELOG)
                                        │  merge
                                  tag vX.Y.Z ──► deploy-prod.yml ──► Kubernetes
```

### Issues

All work starts as an issue; blank issues are disabled. Pick one of the forms in `.github/ISSUE_TEMPLATE/`:

| Template            | Label         | Use when                                                                                                                                                                                               |
| ------------------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Bug report**      | `bug`         | Existing behavior is broken. Asks for repro steps, compose profile, browser, Node version and logs, plus a required checkbox for the [repro-test rule](docs/testing.md#regression-and-contract-rules). |
| **Feature request** | `enhancement` | A new capability or improvement: problem, proposed solution, alternatives, affected area (frontend, backend, sdk, infra, docs).                                                                        |
| **User story**      | `story`       | A planned, user-facing unit of value: _As a / I want / So that_, testable acceptance criteria, explicit out-of-scope. Use _feature request_ for unrefined ideas.                                       |

Security vulnerabilities never go in a public issue; see [SECURITY.md](SECURITY.md).

### Branches

Branch from `main` and include the issue number: `<type>/<issue>-<short-topic>`.

```
feat/123-notification-digest    # new feature or story
fix/456-ws-auth-race            # bug fix
docs/789-api-envelope           # documentation only
refactor/… chore/… ci/…         # same pattern for the other commit types
```

### Commits

Write [Conventional Commits](https://www.conventionalcommits.org/):

```
<type>(<scope>): <subject>

<body: why, not what>

Refs: #123        relates to the issue
Closes: #123      closes the issue when the commit lands on main
```

- **Types** (from `@commitlint/config-conventional`): `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `build`, `ci`, `chore`, `revert`.
- **Breaking change**: `!` after the type (`feat(auth)!: …`) plus a `BREAKING CHANGE:` footer, and follow the versioning rules in [docs/api-conventions.md](docs/api-conventions.md).
- **Scopes** come from the `scope-enum` rule in `.commitlintrc.json`: `auth`, `user`, `analytics`, `tracking`, `audit`, `notification`, `websocket`, `workflows`, `health`, `metrics`, `sdk`, `shared`, `frontend`, `backend`, `worker`, `infra`, `k8s`, `ci`, `docs`, `deps`, `release`. An unknown scope is a warning, not an error, so cross-cutting commits may omit it. When you add a backend module, add its scope there.

Two husky hooks run on every commit:

| Hook         | Runs                                          | Effect                                                                                                                                                   |
| ------------ | --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pre-commit` | `lint-staged` (config in root `package.json`) | ESLint and Prettier on staged backend, helm (the console) and harbor TypeScript; Prettier on staged JSON, Markdown, YAML and CSS. Can reformat or block. |
| `commit-msg` | `commitlint --edit`                           | Checks the message. The hook ends in `\|\| true`, so it never rejects a commit.                                                                          |

Commit messages are not linted in CI, and nothing lints PR titles. What reaches `main` is the squash title of the PR, so that title is the one that must be valid; reviewers check it (see below).

### Pull requests

1. Open the PR against `main`. The template (`.github/pull_request_template.md`) asks for the linked issue (`Closes #123`), what and why, type of change, **test evidence** (commands you ran and their output), and a checklist: conventional PR title, tests (repro test for bug fixes), docs updated, breaking-change rules, no secrets in the diff.
2. CI must be green (see [CI checks](#ci-checks)) and the PR needs at least one approving review (set as branch protection on `main`).
3. One concern per PR; separate refactors from behavior changes, because a mixed diff hides behavior changes from the reviewer.
4. **Squash-merge only** (set as branch protection on `main`). The PR title becomes the commit on `main`, so it must itself be a valid conventional commit: release-please derives the version bump and changelog from it. No workflow lints the title, so the reviewer checks it before squash-merging. One issue, one commit on `main`; the work-in-progress history stays in the PR.

### Releases

`.github/workflows/release-please.yml` runs on every push to `main` (`release-type: node`, one version for the whole monorepo):

- It maintains a **release PR** that accumulates every conventional commit since the last release, bumps the root `package.json` version (`fix` → patch, `feat` → minor, `BREAKING CHANGE` → major) and updates `CHANGELOG.md`.
- Nothing ships until a maintainer **merges the release PR**. The merge creates the tag `vX.Y.Z` and a GitHub release.

### Deploy

The `vX.Y.Z` tag triggers `deploy-prod.yml`: [docs/deployment.md#pipeline](docs/deployment.md#pipeline).

So **merging the release PR is the production deploy button** only when the `RELEASE_PLEASE_TOKEN` secret holds a personal access token or GitHub App token; without it release-please falls back to the default `GITHUB_TOKEN`, whose tag does not start `deploy-prod.yml`, so the tag is pushed by hand instead. Released tags are never deleted or overwritten. Details and setup: [docs/deployment.md#pipeline](docs/deployment.md#pipeline).

### Worked example

1. **Issue**: a _Bug report_ becomes #456 "WS disconnects after token refresh", label `bug`.
2. **Branch**: `git switch -c fix/456-ws-token-refresh`.
3. **Repro test first**: a failing test in `apps/backend/src/modules/websocket/__tests__/` that proves the disconnect.
4. **Fix and commit**:

   ```
   fix(websocket): reauthenticate socket on token refresh instead of dropping

   The gateway treated a refreshed JWT as a new identity and closed the
   connection. Reuse the session when sub matches.

   Closes: #456
   ```

5. **PR**: template filled with `Closes #456` and the `pnpm --filter @tropis/backend test` output. CI green, one approval, squash-merged as `fix(websocket): reauthenticate socket on token refresh`.
6. **Release PR**: release-please adds the fix under _Bug Fixes_ and bumps the patch version.
7. **Ship**: a maintainer merges the release PR, the tag triggers `deploy-prod.yml` (see [Deploy](#deploy) for the token condition), and the new images roll out.

## Code style

- Prettier and ESLint run on staged files in the `pre-commit` hook, and the CI `format` job runs `prettier --check .` over the whole repo. Do not fight the formatter.
- Naming and layout rules: [docs/project-structure.md](docs/project-structure.md). Module boundaries are enforced by dependency-cruiser (`pnpm lint:arch` in backend, helm and harbor).
- `make lint` lints every workspace.

## Test requirements

- New logic ships with unit tests; see [docs/testing.md](docs/testing.md).
- **Bug fix ⇒ repro test.** Every bug-fix PR includes a test that fails without the fix. No repro test, no merge.
- The backend coverage floor in `apps/backend/package.json` must hold; raise it when you add tests, never lower it.
- Proto changes must pass `buf lint` and `buf breaking`, and the regenerated SDK code (`make proto`) must be committed.

## CI checks

`.github/workflows/ci.yml` runs on pushes and pull requests to `main` and `develop`. The workflow token is read-only (`permissions: contents: read`; only `codeql` adds `security-events: write`), a newer push to a pull request cancels its running CI (`concurrency`), and every job has a `timeout-minutes` so a hung step cannot hold a runner for hours. Every action is pinned to a commit SHA with its version in a comment, because a tag can be moved to different code; Dependabot updates the pins. pnpm comes from the root `packageManager` field (`pnpm/action-setup` takes no `version`). Jobs:

| Job              | Checks                                                                                                                                                                                                                                                                      |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `backend`        | Lint, dependency-cruiser, type check, Jest unit tests with coverage threshold, `pnpm audit --prod` (critical), build                                                                                                                                                        |
| `integration`    | Backend integration suite (Testcontainers), after building the native signing service (`cargo build -p signing`) so its conformance suite runs                                                                                                                              |
| `frontend`       | helm: lint, dependency-cruiser, type check, Vitest with coverage, `pnpm audit --prod` (critical), build                                                                                                                                                                     |
| `harbor`         | harbor: lint, dependency-cruiser, type check, Vitest, build                                                                                                                                                                                                                 |
| `desktop`        | Tauri shell compile (`tauri build --no-bundle`)                                                                                                                                                                                                                             |
| `rust`           | Root Cargo workspace (`services/rust/signing`): `cargo fmt --check`, clippy with `-D warnings`, `cargo test`                                                                                                                                                                |
| `docker-backend` | Build one backend image per role (public, private, worker, scheduler), Trivy scan (fails on fixable CRITICAL), SPDX SBOMs                                                                                                                                                   |
| `docker`         | Build the helm, harbor, signing and OPA images, Trivy scan (fails on fixable CRITICAL), SPDX SBOMs                                                                                                                                                                          |
| `licenses`       | Fails on GPL-3.0 or AGPL-3.0 dependencies                                                                                                                                                                                                                                   |
| `shared`         | `packages/shared` build                                                                                                                                                                                                                                                     |
| `policy`         | OPA policies in `infra/opa`: `opa check --strict` and `opa test` (same OPA version as compose)                                                                                                                                                                              |
| `format`         | `prettier --check .`                                                                                                                                                                                                                                                        |
| `sdk`            | `packages/sdk`: type check, build, test                                                                                                                                                                                                                                     |
| `flink`          | `mvn clean compile`                                                                                                                                                                                                                                                         |
| `e2e`            | Mirrors `make test-e2e`: compose stack (waits until every service is healthy), PostgreSQL migrations (`migrate:up`), Jest E2E, then the built backend (waits for `/readyz`), `seed` (tenant `dev` and its admin), and Playwright (Chromium) against it and the helm preview |
| `secrets`        | Gitleaks over the full history (an organization-owned repository needs the `GITLEAKS_LICENSE` secret)                                                                                                                                                                       |
| `codeql`         | CodeQL `security-and-quality` for JavaScript/TypeScript                                                                                                                                                                                                                     |
| `sonarcloud`     | SonarCloud scan with quality gate wait; skipped when `SONAR_TOKEN` is not set                                                                                                                                                                                               |
| `proto`          | `buf lint`, `buf breaking` against the pull request's base branch (PRs only), SDK codegen drift check; buf is the version pinned in `packages/sdk`, the same one `make proto` runs                                                                                          |
| `lighthouse`     | Lighthouse CI on the helm build; assertions are warnings (`apps/frontend/helm/.lighthouserc.json`), so it does not block                                                                                                                                                    |

## Dependabot

`.github/dependabot.yml` opens update PRs every Monday for: npm (workspace root), Maven (`/services/flink`), GitHub Actions, Cargo (`/`, the root workspace, and `/apps/desktop/src-tauri`) and Docker base images (`/apps/backend`, `/apps/frontend/helm`, `/apps/frontend/harbor`, `/services/rust/signing`). npm updates are grouped (`@nestjs/*`, `@opentelemetry/*`, lint/format/test tooling). Major version bumps are ignored for npm and Cargo and need a manual, reviewed upgrade. Dependabot PRs go through the same CI and review as any other PR.

## SonarCloud

One-time setup:

1. Sign up at [sonarcloud.io](https://sonarcloud.io) and link the GitHub organization.
2. Create the project and copy its token.
3. Add `SONAR_TOKEN` under repo **Settings → Secrets and variables → Actions**.

The `sonarcloud` job then reads `sonar-project.properties` (sources: `apps/backend/src`, `apps/frontend/helm/src`, `packages/shared/src`, `packages/sdk/src`; generated code, DTOs, schemas and module wiring excluded) and the LCOV reports of the `backend` (Jest) and `frontend` (helm Vitest) jobs, and waits for the quality gate (`sonar.qualitygate.wait=true`). A failed gate fails CI. Without the secret the scan step is skipped.

## Reporting issues

Use GitHub Issues with the templates described in [Issues](#issues). Security issues follow [SECURITY.md](SECURITY.md), never a public issue.
