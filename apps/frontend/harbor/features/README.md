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
(harbor has no SDK dependency).

The folder holds no feature yet; the layout rules above are enforced by CI
from the first one.
