# Pull request

## Linked issue

<!-- Every PR should trace to an issue (bug / enhancement / story). -->

Closes #

## What & why

<!-- What changed, and why. Link design context (docs/tech-decisions.md, ADR, story) where relevant. -->

## Type of change

- [ ] Bug fix (`fix`)
- [ ] New feature (`feat`)
- [ ] Refactor — no behavior change (`refactor`)
- [ ] Performance (`perf`)
- [ ] Documentation (`docs`)
- [ ] Tests only (`test`)
- [ ] Tooling / CI / deps (`chore`, `ci`, `build`)
- [ ] **Breaking change** (`!` + `BREAKING CHANGE:` footer)

## Test evidence

<!-- Commands you ran and their (trimmed) output. CI runs them too, but show your local proof. -->

```bash
# e.g.
# pnpm --filter @tropis/backend test
# pnpm test:e2e
```

```text
# paste relevant output here
```

## Checklist

- [ ] PR title is a valid conventional commit (it becomes the squash commit and feeds the changelog)
- [ ] Tests added/updated — **bug fix ⇒ repro test that fails without the fix** (docs/testing.md)
- [ ] Docs updated (README / docs/ / .env.example) where behavior or setup changed
- [ ] Breaking change → [docs/api-versioning.md](../blob/main/docs/api-versioning.md) rules followed (`buf breaking` passes, new version introduced instead of mutating v1)
- [ ] No secrets, credentials, or internal URLs in the diff
