/**
 * Architecture rules for frontend/helm — enforces the feature-first layering
 * documented in docs/project-structure.md. Run locally with `pnpm lint:arch`.
 *
 * Layering (one-way):
 *
 *   main.tsx → app/ → pages/ → features/ → (components/, state/, lib/)
 *
 *   - app/        app shell: router, providers, ErrorBoundary, PageTracker.
 *                 Only main.tsx may import it.
 *   - pages/      route-level composition — thin; may use features, shared
 *                 components, state and lib. Never imported by features.
 *   - features/   one folder per domain feature (mirrors backend modules/).
 *                 Cross-feature/page access goes through the feature's
 *                 index.ts barrel only; internals are private.
 *   - components/ shared presentational components — pure: no features,
 *                 pages, state or lib imports.
 *   - state/      three-layer state (local/zustand/tanstack) — may use lib,
 *                 never UI code.
 *   - lib/        SDK wiring (api, tracking, websocket, env, error) — leaf
 *                 layer, imports only packages/.
 */

const TEST_FILES = '(__tests__|\\.test\\.tsx?$|setupTests\\.ts$)';

module.exports = {
  forbidden: [
    {
      name: 'no-circular',
      severity: 'error',
      comment: 'Circular dependencies make modules impossible to reason about or extract.',
      from: {},
      to: { circular: true, dependencyTypesNot: ['type-only'] },
    },
    {
      name: 'only-main-imports-app',
      severity: 'error',
      comment:
        'src/app is the composition root (router, providers, shell). ' +
        'Only the entrypoint main.tsx may import it.',
      from: { path: '^src/', pathNot: ['^src/main\\.tsx$', '^src/app/'] },
      to: { path: '^src/app/' },
    },
    {
      name: 'features-not-into-pages-or-app',
      severity: 'error',
      comment:
        'Dependencies flow one way: pages compose features, never the reverse. ' +
        'A feature that needs something from a page owns it instead.',
      from: { path: '^src/features/' },
      to: { path: '^src/(pages|app)/' },
    },
    {
      name: 'no-cross-feature-imports',
      severity: 'error',
      comment:
        'Features are independent verticals (mirrors backend no-cross-module rule). ' +
        'If two features need the same component, promote it to src/components/; ' +
        'shared logic goes to src/lib or src/state.',
      from: { path: '^src/features/([^/]+)/' },
      to: { path: '^src/features/([^/]+)/', pathNot: ['^src/features/$1/'] },
    },
    {
      name: 'feature-internals-are-private',
      severity: 'error',
      comment:
        'Everything outside a feature imports it through its index.ts barrel — ' +
        'the barrel defines the feature\'s public surface (like a backend module\'s exports).',
      from: { path: '^src/', pathNot: ['^src/features/'] },
      to: { path: '^src/features/[^/]+/.', pathNot: ['^src/features/[^/]+/index\\.ts$'] },
    },
    {
      name: 'shared-components-are-presentational',
      severity: 'error',
      comment:
        'src/components holds shared *presentational* components (toasts, spinners). ' +
        'They receive everything via props — no feature, page, state or lib imports. ' +
        'A component that needs those belongs inside a feature. ' +
        'Sole exception: src/lib/utils.ts (the shadcn `cn` class-name helper) — ' +
        'a pure function with no app wiring, needed by src/components/ui.',
      from: { path: '^src/components/' },
      to: {
        path: '^src/(features|pages|state|lib|app)/',
        pathNot: ['^src/lib/utils\\.ts$'],
      },
    },
    {
      name: 'state-not-into-ui',
      severity: 'error',
      comment:
        'State hooks/stores are UI-agnostic: they may wrap src/lib API calls but ' +
        'never import components, features, pages or the app shell.',
      from: { path: '^src/state/' },
      to: { path: '^src/(features|pages|components|app)/' },
    },
    {
      name: 'lib-is-a-leaf',
      severity: 'error',
      comment:
        'src/lib wires up the SDK (api, tracking, websocket, env, error) and depends ' +
        'only on packages/ — never on state, features, pages or components.',
      from: { path: '^src/lib/' },
      to: { path: '^src/(features|pages|components|state|app)/' },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    exclude: { path: TEST_FILES },
    tsPreCompilationDeps: true, // needed to see (and classify) type-only imports
    tsConfig: { fileName: 'tsconfig.app.json' },
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'require', 'node', 'default', 'types'],
      mainFields: ['module', 'main', 'types', 'typings'],
    },
  },
};
