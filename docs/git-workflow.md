# Git workflow — issue → branch → PR → release → deploy

The full chain from "someone found a problem" to "it's running in production". Companion to [CONTRIBUTING.md](../CONTRIBUTING.md) (setup, code style, test requirements).

```
Issue (#123) ──► branch feat/123-… ──► conventional commits ──► PR (squash) ──► main
                                                                                  │
                              release-please accumulates commits ◄───────────────┘
                                        │
                             release PR (version bump + CHANGELOG)
                                        │  merge
                                  tag vX.Y.Z ──► deploy-prod.yml ──► K8s
```

## 1. Issues — pick the right template

All work starts as an issue (blank issues are disabled). Three forms under `.github/ISSUE_TEMPLATE/`:

| Template            | Label         | Use when                                                                                                                                                                                                                                                       |
| ------------------- | ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Bug report**      | `bug`         | Existing behavior is broken. Includes repro steps, environment (compose profile / browser / Node), logs — and a checkbox acknowledging the **bug-first repro test** rule ([docs/testing.md](testing.md)): the fix must ship with a test that fails without it. |
| **Feature request** | `enhancement` | New capability or improvement. Problem → proposed solution → alternatives → affected area (frontend/backend/sdk/infra/docs).                                                                                                                                   |
| **User story**      | `story`       | Planned, user-facing unit of value: _As a / I want / So that_ + testable acceptance criteria + explicit out-of-scope. Use for sprint-planned work; use _feature request_ for unrefined ideas.                                                                  |

Security vulnerabilities: **never** a public issue — see `SECURITY.md`.

## 2. Branch naming

Branch from `main`, include the issue number:

```
feat/123-short-desc       # new feature / story
fix/456-short-desc        # bug fix
docs/789-short-desc       # documentation only
refactor/…  chore/…       # as in CONTRIBUTING.md
```

Examples: `feat/123-notification-digest`, `fix/456-ws-auth-race`.

## 3. Commits — Conventional Commits with scopes

Format (enforced by commitlint via the husky `commit-msg` hook, config in `.commitlintrc.json`):

```
<type>(<scope>): <subject>

<body — why, not what>

Refs: #123        ← relates to the issue
Closes: #123      ← auto-closes the issue when the commit lands on main
```

Types: `feat`, `fix`, `docs`, `refactor`, `perf`, `test`, `chore`, `ci`, `build`, `revert`.
Breaking change: `feat(auth)!: …` + a `BREAKING CHANGE:` footer, and follow [docs/api-versioning.md](api-versioning.md).

**Scopes** (warned, not blocked — cross-cutting commits may omit or deviate): a scope is a backend module name (`auth`, `user`, …), a package/app (`sdk`, `frontend`, …), or an ops area (`infra`, `ci`, `deps`, …). The authoritative list lives in `.commitlintrc.json` — add the scope there when you add a module.

```
feat(notification): add daily digest scheduler

Refs: #123
```

## 4. Pull requests

1. Open a PR against `main`; the template (`.github/pull_request_template.md`) asks for the linked issue (`Closes #123`), what & why, type of change, **test evidence** (commands + output), and a checklist (docs, tests, API versioning for breaking changes).
2. CI fully green + at least one approving review (see CONTRIBUTING.md).
3. **Squash-merge only.** The PR title becomes the squash commit, so it **must itself be a valid conventional commit** — release-please and the changelog read it. Rationale: one issue → one commit on `main`; the fine-grained WIP history stays in the PR.

## 5. Releases & deploy — release-please

`.github/workflows/release-please.yml` runs on every push to `main`:

- It maintains a **release PR** that accumulates all conventional commits since the last release: bumps the root `package.json` version (`feat` → minor, `fix` → patch, `BREAKING CHANGE` → major) and updates `CHANGELOG.md`.
- Nothing ships until a maintainer **merges the release PR**. Merging it creates the tag `vX.Y.Z` and a GitHub release.
- The tag matches `deploy-prod.yml`'s trigger (`v[0-9]+.[0-9]+.[0-9]+`), which builds/pushes images and deploys to Kubernetes ([docs/deployment.md](deployment.md)).

So: **merging the release PR is the production deploy button.**

## 6. Worked example — end to end

1. **Issue**: a user files _Bug report_ → issue **#456** "WS disconnects after token refresh", label `bug`, repro-test checkbox ticked.
2. **Branch**: `git switch -c fix/456-ws-token-refresh`.
3. **Repro test first**: add a failing test in `apps/backend/src/modules/websocket/` proving the disconnect.
4. **Fix + commit**:

   ```
   fix(websocket): reauthenticate socket on token refresh instead of dropping

   The gateway treated a refreshed JWT as a new identity and closed the
   connection. Reuse the session when sub matches.

   Closes: #456
   ```

5. **PR**: template filled — `Closes #456`, test evidence (`pnpm --filter @tropis/backend test` output), checklist. CI green, one approval, **squash-merged** with title `fix(websocket): reauthenticate socket on token refresh`.
6. **Release PR**: release-please updates its open release PR — `0.4.2 → 0.4.3`, CHANGELOG gains the fix under _Bug Fixes_. Issue #456 auto-closes.
7. **Ship**: maintainer merges the release PR → tag `v0.4.3` → `deploy-prod.yml` builds images, applies the prod overlay, waits for rollout (auto-rollback on failure).
