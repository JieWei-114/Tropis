# Backend Proposal: <Feature Name>

> Status: draft | in-review | approved · PRD: ./prd.md

## Approach

The chosen design in a few paragraphs. Diagrams welcome (ASCII fine).

## Alternatives considered

| Option     | Pros | Cons | Verdict |
| ---------- | ---- | ---- | ------- |
| A (chosen) |      |      | ✅      |
| B          |      |      | ❌ why  |

## Touched areas

- Modules: `modules/<x>/...` (new files per [PROJECT-STRUCTURE](../../project-structure.md) anatomy)
- Contracts: see ./contracts.yaml
- Data: schema/migration changes
- Infra: new env vars, compose/k8s changes

## Failure modes & degradation

What happens when each dependency is down (align with the degradation table
in [TECH-DECISIONS](../../tech-decisions.md)).

## Test plan

Unit / integration / E2E — what proves each acceptance criterion.

## Rollout & rollback

Feature flag? Migration order? How to undo.
