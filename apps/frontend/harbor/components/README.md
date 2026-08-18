# components/

Shared **presentational** components for the public site (buttons, cards, layout
chrome). Pure — they receive everything via props and import nothing from
`app/`, `features/`, or `lib/` (sole exception: `lib/utils.ts`).

A component that needs data, config, or feature logic belongs in a `features/`
folder instead. Enforced by `.dependency-cruiser.cjs` (`pnpm lint:arch`).

Put design primitives under `components/ui/`.
