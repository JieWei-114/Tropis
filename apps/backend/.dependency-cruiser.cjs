/**
 * Architecture rules for apps/backend — enforces the layering documented in
 * docs/project-structure.md. Run locally with `pnpm lint:arch`.
 *
 * Layering:  controllers/, processors/ → services/ → repositories/ → schemas/
 * Drivers:   only src/infrastructure/** may import DB/broker drivers at runtime.
 *            Type-only imports (`import type …`) are allowed everywhere —
 *            business code injects infrastructure services via DI tokens and
 *            only needs the driver's *types* for annotations.
 */

// External DB/broker drivers that business code must not import at runtime.
const DRIVER_PACKAGES =
  'node_modules/(mongoose|ioredis|pulsar-client|@clickhouse/client|@elastic/elasticsearch|aerospike|pg|minio|@temporalio)(/|$)';

const TEST_FILES = '(__tests__|\\.spec\\.ts$|\\.e2e-spec\\.ts$)';

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
      name: 'controllers-not-into-repositories',
      severity: 'error',
      comment:
        'Controllers are thin: parse input, call a service, return a DTO. ' +
        'Never import a repository directly — go through services/.',
      from: { path: '^src/modules/[^/]+/controllers/' },
      to: { path: '^src/modules/[^/]+/repositories/' },
    },
    {
      name: 'controllers-not-into-schemas',
      severity: 'error',
      comment:
        'Schemas never cross the API boundary; controllers must not import them. ' +
        'Domain enums that controllers legitimately need (UserRole, UserStatus, ' +
        "AnalyticsEventType) live in each module's constants/ for exactly this reason.",
      from: { path: '^src/modules/[^/]+/controllers/' },
      to: { path: '^src/modules/[^/]+/schemas/' },
    },
    {
      name: 'processors-not-into-repositories-or-schemas',
      severity: 'error',
      comment:
        'Processors are thin like controllers — delegate to services/. ' +
        'TODO: analytics, tracking and user processors currently write through their own ' +
        "module's repository directly; route them through a service method and drop the exemptions.",
      from: {
        path: '^src/modules/[^/]+/processors/',
        pathNot: [
          '^src/modules/analytics/processors/analytics\\.processor\\.ts$',
          '^src/modules/tracking/processors/tracking\\.processor\\.ts$',
          '^src/modules/user/processors/user\\.processor\\.ts$',
        ],
      },
      to: { path: '^src/modules/[^/]+/(repositories|schemas)/' },
    },
    {
      name: 'no-cross-module-repositories-or-schemas',
      severity: 'error',
      comment:
        "Cross-module access goes through the other module's services (or events) — " +
        'never its repositories/ or schemas/. ' +
        "TODO: auth currently imports user's schema (UserRole/UserStatus/DEFAULT_TENANT enums + " +
        'UserDocument type) and oauth.service uses UserRepository directly. Promote the shared ' +
        'enums/constants to src/common/ (tier 2) and route oauth through UserService, then drop ' +
        'the exemptions.',
      from: {
        path: '^src/modules/([^/]+)/',
        pathNot: [
          '^src/modules/auth/services/(auth|oauth)\\.service\\.ts$',
          '^src/modules/auth/strategies/jwt\\.strategy\\.ts$',
        ],
      },
      to: {
        path: '^src/modules/([^/]+)/(repositories|schemas)/',
        pathNot: ['^src/modules/$1/(repositories|schemas)/'],
      },
    },
    {
      name: 'only-infrastructure-imports-drivers',
      severity: 'error',
      comment:
        'Each external system is owned by exactly one module under src/infrastructure/. ' +
        "Business code injects that module's service/token; it never imports the driver at " +
        'runtime. Type-only imports (import type) are fine for annotations.',
      from: { path: '^src', pathNot: ['^src/infrastructure/', TEST_FILES] },
      to: {
        path: DRIVER_PACKAGES,
        dependencyTypesNot: ['type-only'],
      },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    exclude: { path: TEST_FILES },
    tsPreCompilationDeps: true, // needed to see (and classify) type-only imports
    tsConfig: { fileName: 'tsconfig.json' },
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'require', 'node', 'default', 'types'],
      mainFields: ['module', 'main', 'types', 'typings'],
    },
  },
};
