# Contributing

## Getting started

```bash
make install   # pnpm install (workspace root)
make up        # core infrastructure via docker compose
make dev       # backend + frontend + temporal worker in watch mode
```

Read `docs/project-structure.md` (where code goes) and `docs/adding-a-feature.md` (how to add a module) before your first PR.

## Branches, commits & releases

The full chain — issue templates, branch naming (`feat/123-short-desc`), commit format with the scope list and `Refs:`/`Closes:` footers, and the release-please → tag → deploy flow — is documented in **[docs/git-workflow.md](docs/git-workflow.md)**. Read it before your first PR.

Short version: branch from `main` as `<type>/<issue>-<short-topic>`, and write [Conventional Commits](https://www.conventionalcommits.org/) — enforced by **commitlint** via the husky `commit-msg` hook (scopes live in `.commitlintrc.json`), e.g. `fix(outbox): stop double-publishing on relay restart`. Allowed types: `feat`, `fix`, `docs`, `refactor`, `perf`, `test`, `chore`, `ci`, `build`, `revert`. Breaking changes: `!` after the type and a `BREAKING CHANGE:` footer.

## Code style

- **Prettier + ESLint run automatically** on staged files via husky pre-commit (`lint-staged` config in root `package.json`). Don't fight the formatter.
- Naming and layout rules: `docs/project-structure.md` (kebab-case files with type suffix, layered modules, no magic strings).
- `make lint` runs the full lint across the workspace.

## Test requirements

- New logic in `services/` or `utils/` ships with unit tests (80%+ coverage on those layers — see `docs/testing.md`).
- **Bug fix ⇒ repro test.** Every bug-fix PR must include a test that fails without the fix. No repro test, no merge.
- Contract-affecting changes (proto/REST/events) must pass `buf breaking` and follow `docs/api-versioning.md`.

## PR process

1. Open a PR against `main` with a clear description: what, why, how tested.
2. CI must be fully green (lint, unit tests, build, audit, CodeQL, gitleaks, SonarCloud quality gate).
3. At least one approving review.
4. Keep PRs focused — separate refactors from behavior changes.
5. Squash-merge; the squash title must itself be a valid conventional commit (it feeds the changelog).

## Reporting issues

Use GitHub Issues with the provided templates (bug report / feature request / user story — see [docs/git-workflow.md](docs/git-workflow.md)). Security issues: see [SECURITY.md](SECURITY.md) — never a public issue.
