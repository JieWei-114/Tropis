# Feature Workflow Docs (docs first)

**Docs before code.** Every non-trivial feature/project gets a folder here.
The folder captures the _thinking_ — requirements, trade-offs, decisions,
progress — so future readers can understand not just _what_ the code does,
but _why it was built this way_. Code shows the result; this shows the reasoning.

## When to create a folder

- New feature spanning more than one module, or touching contracts (proto/REST/events)
- Migration, redesign, or anything with alternatives worth debating
- NOT needed for: small bug fixes, dependency bumps, doc typos (the issue + PR is enough)

## Structure

```
docs/workflow/<kebab-case-feature-name>/
├── prd.md                  # REQUIRED — what & why (product view)
├── scope.md                # in/out of scope, phases (if PRD is big)
├── proposal-backend.md     # HOW — technical design (one per area if needed:
├── proposal-frontend.md    #   proposal-frontend.md, proposal-infra.md)
├── contracts.yaml          # API/event contracts agreed BEFORE coding:
│                           #   proto RPCs, REST endpoints, event payloads, DB schema deltas
├── tasks.yaml              # task breakdown + status (the execution checklist)
├── decisions.md            # decision log: every fork in the road — options
│                           #   considered, choice made, WHY (this is the gold)
├── dev-log/                # working notes per topic/day — debugging trails,
│                           #   dead ends, discoveries (messy is fine here)
├── qa-checklist.md         # manual QA pass: smoke/boundary/regression scope,
│                           #   cross-browser + viewport, sign-off table
└── acceptance-report.md    # CLOSING — what shipped, test evidence,
                            #   what was cut, follow-ups
```

Minimum viable set: `prd.md` → `proposal-*.md` → `acceptance-report.md`.
Add the rest when the feature is big enough to need them.

## Lifecycle

| Stage     | File                                           | Gate                                                              |
| --------- | ---------------------------------------------- | ----------------------------------------------------------------- |
| 1. Define | prd.md (+ scope.md)                            | Reviewer agrees the problem is worth solving                      |
| 2. Design | proposal-\*.md + contracts.yaml + decisions.md | Design reviewed BEFORE code; contracts frozen                     |
| 3. Build  | tasks.yaml + dev-log/                          | Tasks tracked; discoveries logged as they happen                  |
| 4. Close  | acceptance-report.md                           | Evidence attached; issue closed; folder becomes read-only history |

## Rules

1. **PRD before proposal, proposal before code.** A PR for a feature without a
   workflow folder (when one is warranted) should be pushed back in review.
2. **decisions.md is append-only.** Never rewrite history — if a decision is
   reversed, add a new entry pointing at the old one.
3. Link the folder from the GitHub issue and the PR description.
4. Contracts in `contracts.yaml` follow [docs/api-versioning.md](../api-versioning.md)
   add-only rules once implemented.
5. Folders are permanent. Closed features stay here as institutional memory —
   this is how future maintainers read the original thinking.
6. AI agents: read `prd.md` + `proposal-*.md` + `decisions.md` before touching
   the feature's code; append to `dev-log/`, never rewrite others' entries.

Copy `_template/` to start a new feature:

```bash
cp -r docs/workflow/_template docs/workflow/my-feature-name
```
