# QA Checklist — <feature name>

> Copy with the rest of `_template/` into the feature's workflow folder.
> Fill during the Build/Close stages; attach evidence (screenshots, run
> links) in `acceptance-report.md`. Automated coverage (unit/integration/E2E
> per docs/testing.md) is assumed — this checklist covers the manual gap.

## Regression scope

**Which existing flows does this change touch?** List them explicitly —
shared modules, contracts (proto/REST/events), DB schema, UI routes. Each
listed flow must be re-verified (via the E2E smoke set or manually below).

| Touched flow                       | How verified       | Result |
| ---------------------------------- | ------------------ | ------ |
| _e.g. login (auth module changed)_ | E2E smoke / manual | ☐      |

## Smoke

- [ ] **Auth**: login (password), token refresh, logout; protected route rejects without token
- [ ] **CRUD**: create → appears in list → edit persists → delete removes (users or the feature's entity)
- [ ] **Realtime**: WebSocket updates arrive in a second browser tab without reload
- [ ] **Tracking**: page/actions emit events; batch ingest returns 202 (`POST /api/v1/track`)

## Boundary / edge cases

- [ ] **Empty states**: lists/searches with zero results render a sane empty state, not errors
- [ ] **Long input**: max-length and over-max text (names, free-text fields) — validated, not truncated silently, layout doesn't break
- [ ] **Concurrent edits**: same record edited in two tabs/users — no silent data loss; last-write or conflict behavior is deliberate
- [ ] **Offline / PWA**: kill the network mid-flow — app degrades gracefully, queued actions (e.g. tracker beacon) flush on reconnect

## Cross-browser & viewport

- [ ] Chromium (default E2E run)
- [ ] Firefox + WebKit (`E2E_ALL_BROWSERS=1 npx playwright test` in `e2e/`)
- [ ] Mobile viewport (375×667): navigation usable, tables/forms don't overflow
- [ ] Tablet viewport (768×1024)

## Sign-off

| Role          | Name | Date | Verdict (pass / pass w/ notes / fail) |
| ------------- | ---- | ---- | ------------------------------------- |
| Developer     |      |      |                                       |
| QA / Reviewer |      |      |                                       |
| Product       |      |      |                                       |

Notes / known issues carried forward:

-
