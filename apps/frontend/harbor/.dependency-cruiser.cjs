/**
 * Architecture rules for apps/frontend/harbor — enforces the layering documented
 * in docs/project-structure.md. Run locally with `pnpm lint:arch`.
 *
 * Layering (one-way), the Next App Router mirror of helm's feature-first rules:
 *
 *   app/ → features/ → (components/, lib/)
 *
 *   - app/        routes only: pages, layouts, route handlers, metadata,
 *                 robots.ts / sitemap.ts. The composition root that Next loads —
 *                 nothing outside app/ may import it. Composes features + lib.
 *   - features/   one folder per domain feature (pricing, blog, …). Cross-feature
 *                 access goes through the feature's index.ts barrel only.
 *   - components/ shared *presentational* components — pure: props only, no
 *                 feature/app imports. Sole exception: lib/utils.
 *   - lib/        leaf layer: site config + utils today. When harbor needs
 *                 backend data, add @tropis/sdk here (it is not a dependency yet).
 *                 Imports only packages/ — never app/features/components.
 */

const TEST_FILES = '(__tests__|\\.test\\.tsx?$)';

module.exports = {
  forbidden: [
    {
      name: 'no-circular',
      severity: 'error',
      comment:
        'Circular dependencies make modules impossible to reason about or extract.',
      from: {},
      to: { circular: true, dependencyTypesNot: ['type-only'] },
    },
    {
      name: 'nothing-imports-routes',
      severity: 'error',
      comment:
        'app/ holds Next routes (Next loads them) — it is the composition root. ' +
        'Shared UI/logic belongs in components/, features/ or lib/, not app/. ' +
        'Colocation *within* a route folder is fine; importing app/ from outside is not.',
      from: { path: '^(features|components|lib)/' },
      to: { path: '^app/' },
    },
    {
      name: 'features-not-into-app',
      severity: 'error',
      comment:
        'Dependencies flow one way: app composes features, never the reverse.',
      from: { path: '^features/' },
      to: { path: '^app/' },
    },
    {
      name: 'no-cross-feature-imports',
      severity: 'error',
      comment:
        'Features are independent verticals (mirrors backend no-cross-module rule). ' +
        'Shared UI → components/; shared logic → lib/.',
      from: { path: '^features/([^/]+)/' },
      to: { path: '^features/([^/]+)/', pathNot: ['^features/$1/'] },
    },
    {
      name: 'feature-internals-are-private',
      severity: 'error',
      comment:
        'Everything outside a feature imports it through its index.ts barrel — ' +
        "the barrel defines the feature's public surface.",
      from: { path: '^', pathNot: ['^features/'] },
      to: {
        path: '^features/[^/]+/.',
        pathNot: ['^features/[^/]+/index\\.ts$'],
      },
    },
    {
      name: 'shared-components-are-presentational',
      severity: 'error',
      comment:
        'components/ holds shared presentational components — props only, no ' +
        'feature/app/lib imports. A component that needs those belongs in a feature. ' +
        'Sole exception: lib/utils.ts (pure class-name helper).',
      from: { path: '^components/' },
      to: { path: '^(features|app|lib)/', pathNot: ['^lib/utils\\.ts$'] },
    },
    {
      name: 'lib-is-a-leaf',
      severity: 'error',
      comment:
        'lib/ wires site config and the SDK; it depends only on packages/ — ' +
        'never on app, features or components.',
      from: { path: '^lib/' },
      to: { path: '^(app|features|components)/' },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    exclude: { path: `(node_modules|\\.next|${TEST_FILES})` },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: 'tsconfig.json' },
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'require', 'node', 'default', 'types'],
      mainFields: ['module', 'main', 'types', 'typings'],
    },
  },
};
