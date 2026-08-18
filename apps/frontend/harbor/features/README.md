# features/

One folder per domain feature of the public site (e.g. `pricing/`, `blog/`,
`waitlist/`) — the Next mirror of a backend module and of helm's `features/`.

Rules (enforced by `.dependency-cruiser.cjs`, `pnpm lint:arch`):

- **Public surface via `index.ts` barrel** — everything outside the feature
  imports it through `features/<name>/index.ts`; internals are private.
- **No cross-feature imports** — independent verticals. Shared UI → `components/`;
  shared logic/config → `lib/`.
- **One-way flow** — `app/` routes compose features; features never import `app/`.

A feature holds its route-specific components and types. When a feature needs
backend data, add `@tropis/sdk` as a dependency and wire the calls in `lib/`
(harbor is a static marketing site today and does not depend on the SDK yet).

> Note: this folder is currently empty — the layout is defined and CI-enforced
> ahead of the first real feature, not retrofitted after sprawl.
