/**
 * Architecture rules for apps/backend — enforces the layering documented in
 * docs/project-structure.md. Run locally with `pnpm lint:arch`.
 *
 * Tiers:        infrastructure/ (capabilities) and common/ (cross-cutting)
 *               → modules/ (foundation modules) → features/ (product
 *               features); roles/ compose them. Nothing depends on a tier
 *               above it, and features never depend on each other.
 * Layering:     controllers/, gateways/, processors/ → services/ →
 *               repositories/ → schemas/
 * Capabilities: business code depends on src/infrastructure/<capability>/
 *               <capability>.port.ts (interface + DI token). Technology lives
 *               in src/infrastructure/<capability>/adapters/<tech>/, and
 *               driver clients shared by several adapters live in
 *               src/infrastructure/connections/<tech>/.
 * Drivers:      only adapters and connections import driver packages at
 *               runtime. Type-only imports (`import type …`) are allowed
 *               outside ports, for annotations.
 */

// Driver packages: the technology behind a capability port.
const DRIVER_PACKAGES =
  'node_modules/(' +
  [
    'mongoose',
    '@nestjs/mongoose',
    'ioredis',
    'pulsar-client',
    'kafkajs',
    '@clickhouse/client',
    '@elastic/elasticsearch',
    '@nestjs/elasticsearch',
    'aerospike',
    'pg',
    'typeorm',
    '@nestjs/typeorm',
    'minio',
    '@temporalio/[^/]+',
    'neo4j-driver',
    'nodemailer',
    'bullmq',
    '@nestjs/bullmq',
    '@bull-board/[^/]+',
    'node-vault',
    'socket.io',
    '@socket.io/redis-adapter',
    '@socket.io/redis-emitter',
  ].join('|') +
  ')(/|$)';

const MONGOOSE = 'node_modules/(mongoose|@nestjs/mongoose)(/|$)';
const TEMPORAL_WORKFLOW_SDK = 'node_modules/@temporalio/workflow(/|$)';

const TEST_FILES = '(__tests__|\\.spec\\.ts$|\\.e2e-spec\\.ts$)';

const ADAPTERS = '^src/infrastructure/[^/]+/adapters/';
const CONNECTIONS = '^src/infrastructure/connections/';

/** Business code: foundation modules and product features. */
const BUSINESS = '^src/(modules|features)/';
/** A module's or feature's own folder, captured as $1. */
const UNIT = '^src/(?:modules|features)/([^/]+)/';

/** Inbound transports: controllers, gateways, processors. */
const TRANSPORTS =
  '^src/(modules|features)/[^/]+/(controllers|gateways|processors)/';

/** What only the worker role runs: consumers, job and workflow workers, the relay. */
const BACKGROUND_WORK = [
  '/processors/',
  '\\.processor\\.ts$',
  '\\.job\\.ts$',
  '/workflows/',
  '\\.workflow\\.ts$',
  '^src/infrastructure/outbox/outbox-relay\\.module\\.ts$',
  '^src/infrastructure/outbox/outbox\\.relay\\.ts$',
  '^src/infrastructure/jobs/jobs-workers\\.module\\.ts$',
  '^src/infrastructure/jobs/adapters/bullmq/bullmq-workers\\.',
  '^src/infrastructure/workflow/workflow-worker\\.module\\.ts$',
  '^src/infrastructure/workflow/adapters/temporal/temporal-worker\\.service\\.ts$',
];

/** Inbound APIs: HTTP controllers, RPC handlers, WebSocket gateways, the RPC server. */
const INBOUND_API = [
  '/controllers/',
  '\\.controller\\.ts$',
  '/gateways/',
  '\\.gateway\\.ts$',
  '^src/infrastructure/rpc/',
];

const DASHBOARD = [
  '^src/infrastructure/jobs/jobs-dashboard\\.module\\.ts$',
  '^src/infrastructure/jobs/adapters/bullmq/(bull-board|bullmq-dashboard)',
];

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

    // ── Tiers: foundation never depends on what is built on it ──
    {
      name: 'foundation-not-into-business',
      severity: 'error',
      comment:
        'Capabilities (infrastructure/), cross-cutting code (common/) and config/ are ' +
        'the foundation every product builds on: they never import a foundation module ' +
        'or a product feature, so neither can be removed or swapped without them noticing. ' +
        'Product flows register into the foundation (JobsModule.forFeature, ' +
        'WorkflowModule.forFeature, @Authorize resources, metric providers) instead.',
      from: {
        path: '^src/(infrastructure|common|config)/',
        pathNot: TEST_FILES,
      },
      to: { path: BUSINESS },
    },
    {
      name: 'modules-not-into-features',
      severity: 'error',
      comment:
        'Foundation modules (src/modules/) run in every product; a product feature ' +
        '(src/features/) is optional. A foundation module importing a feature could ' +
        'not boot without it, so removing the feature would break the foundation.',
      from: { path: '^src/modules/' },
      to: { path: '^src/features/' },
    },
    {
      name: 'no-cross-feature-imports',
      severity: 'error',
      comment:
        'Features are independent: removing one never touches another. A contract two ' +
        'features share (an event) lives in @tropis/shared; a capability both need is ' +
        'imported by each.',
      from: { path: '^src/features/([^/]+)/' },
      to: { path: '^src/features/', pathNot: '^src/features/$1/' },
    },
    {
      name: 'features-use-module-public-surface',
      severity: 'error',
      comment:
        "A feature reaches a foundation module only through its public surface: the module's " +
        '*.module.ts files and its services/, constants/, interfaces/ and dto/. Everything ' +
        'else (repositories, schemas, transports, CQRS internals) may change without notice.',
      from: { path: '^src/features/' },
      to: {
        path: '^src/modules/',
        pathNot:
          '^src/modules/[^/]+/([^/]+\\.module\\.ts$|(services|constants|interfaces|dto)/)',
      },
    },

    // ── Layering inside a module or feature ──
    {
      name: 'transports-not-into-repositories-or-schemas',
      severity: 'error',
      comment:
        'Controllers, gateways and processors are thin: parse input, call a service, ' +
        'return a DTO. They never import a repository or a schema — go through services/. ' +
        'Domain enums transports need live in constants/ for this reason.',
      from: { path: TRANSPORTS },
      to: { path: '^src/(modules|features)/[^/]+/(repositories|schemas)/' },
    },
    {
      name: 'no-cross-unit-repositories-or-schemas',
      severity: 'error',
      comment:
        "Cross-module access goes through the other module's services (or events) — " +
        'never its repositories/, schemas/ or event-store/.',
      from: { path: UNIT },
      to: {
        path: '^src/(?:modules|features)/([^/]+)/(repositories|schemas|event-store)/',
        pathNot: [
          '^src/modules/$1/(repositories|schemas|event-store)/',
          '^src/features/$1/(repositories|schemas|event-store)/',
        ],
      },
    },

    // ── Capabilities and drivers ──
    {
      name: 'only-adapters-import-drivers',
      severity: 'error',
      comment:
        'A driver package is technology, so only capability adapters and shared ' +
        'connections import it at runtime; everything else injects a port by its DI ' +
        'token. Type-only imports (import type) are fine for annotations. ' +
        'mongoose/@nestjs/mongoose are governed by mongoose-only-in-persistence; ' +
        'workflow definitions by workflow-sdk-only-in-workflows.',
      from: {
        path: '^src',
        pathNot: [ADAPTERS, CONNECTIONS, TEST_FILES],
      },
      to: {
        path: DRIVER_PACKAGES,
        pathNot: [MONGOOSE, TEMPORAL_WORKFLOW_SDK],
        dependencyTypesNot: ['type-only'],
      },
    },
    {
      name: 'mongoose-only-in-persistence',
      severity: 'error',
      comment:
        'The one driver allowed outside adapters: repositories are the documents adapter ' +
        'layer of their module (a query-shaped port would only re-implement the ODM), so ' +
        'mongoose stays in repositories/, schemas/, event-store/ and the outbox, and a ' +
        '*.module.ts registers its schemas with MongooseModule.forFeature. Services and ' +
        'commands open transactions through DocumentsPort.withTransaction, never a ' +
        'Mongoose connection or session.',
      from: {
        path: '^src',
        pathNot: [
          ADAPTERS,
          CONNECTIONS,
          TEST_FILES,
          '^src/(modules|features)/[^/]+/(repositories|schemas|event-store)/',
          '^src/(modules|features)/[^/]+/[^/]+\\.module\\.ts$',
          '^src/infrastructure/outbox/outbox\\.(schema|service|module)\\.ts$',
        ],
      },
      to: { path: MONGOOSE, dependencyTypesNot: ['type-only'] },
    },
    {
      name: 'workflow-sdk-only-in-workflows',
      severity: 'error',
      comment:
        'Workflow definitions run inside the workflow engine and are written against its ' +
        'SDK, so a *.workflow.ts file may import @temporalio/workflow; nothing else ' +
        'outside the workflow adapter may.',
      from: {
        path: '^src',
        pathNot: [ADAPTERS, TEST_FILES, '\\.workflow\\.ts$'],
      },
      to: { path: TEMPORAL_WORKFLOW_SDK },
    },
    {
      name: 'ports-have-no-driver-types',
      severity: 'error',
      comment:
        'A port is the contract every adapter implements, so it names domain types ' +
        'only — not even a type-only import of a driver. Applies to every *.port.ts, ' +
        'in infrastructure/ and common/.',
      from: { path: '\\.port\\.ts$' },
      to: { path: DRIVER_PACKAGES },
    },
    {
      name: 'business-not-into-capability-adapters',
      severity: 'error',
      comment:
        'Business code depends on a capability port (<capability>.port.ts) and its DI ' +
        'token, never on an adapter: the adapter is chosen by configuration in the ' +
        "capability's module, so importing one bypasses that choice.",
      from: { path: '^src/(modules|features|common)/' },
      to: { path: ADAPTERS },
    },
    {
      name: 'business-not-into-connections',
      severity: 'error',
      comment:
        'Shared driver clients (src/infrastructure/connections/) exist for adapters. ' +
        'Business code reaching one bypasses the port it should use.',
      from: { path: '^src/(modules|features|common)/' },
      to: { path: CONNECTIONS },
    },
    {
      name: 'connections-only-from-adapters',
      severity: 'error',
      comment:
        'Within infrastructure, a connection is used by adapters, by the capability ' +
        'modules that import it for their adapter and by other connections — never by ' +
        'ports or capability clients.',
      from: {
        path: '^src/infrastructure/',
        pathNot: [
          ADAPTERS,
          CONNECTIONS,
          '^src/infrastructure/[^/]+/[^/]+\\.module\\.ts$',
          TEST_FILES,
        ],
      },
      to: { path: CONNECTIONS },
    },

    // ── Roles (src/roles/<role>/): each root reaches only what it runs ──
    {
      name: 'roles-are-composition-roots',
      severity: 'error',
      comment:
        'A role root composes building blocks; nothing but another root or an ' +
        'entry point imports it, so a feature can never pull a whole role in.',
      from: {
        path: '^src/',
        pathNot: ['^src/roles/', '^src/main\\.ts$', '^src/app\\.module\\.ts$'],
      },
      to: { path: '^src/roles/' },
    },
    {
      name: 'roles-import-no-other-role',
      severity: 'error',
      comment:
        'A role reaches shared building blocks (src/roles/shared/), modules and ' +
        'features, never another role: only the `all` root (app.module.ts) combines them.',
      from: { path: '^src/roles/(public|private|worker|scheduler)/' },
      to: {
        path: '^src/roles/(public|private|worker|scheduler)/',
        pathNot: '^src/roles/$1/',
      },
    },
    {
      name: 'public-role-no-background-work',
      severity: 'error',
      comment:
        'The public role serves requests only: consumers, job and workflow workers, ' +
        'workflow definitions, the outbox relay and cron triggers belong to ' +
        'worker/scheduler, so scaling the API never multiplies background work.',
      from: { path: '^src/roles/public/' },
      to: {
        path: [...BACKGROUND_WORK, '\\.schedule\\.ts$'],
        reachable: true,
      },
    },
    {
      name: 'private-role-internal-rpc-only',
      severity: 'error',
      comment:
        'The private role opens the internal RPC listener only: no HTTP ' +
        'controllers, public RPC services, gateways, dashboard or background work.',
      from: { path: '^src/roles/private/' },
      to: {
        path: [
          '/controllers/',
          '\\.controller\\.ts$',
          '/gateways/',
          '\\.gateway\\.ts$',
          ...BACKGROUND_WORK,
          '\\.schedule\\.ts$',
          ...DASHBOARD,
        ],
        pathNot: [
          '-internal\\.rpc\\.controller\\.ts$',
          '^src/modules/health/controllers/health\\.rpc\\.controller\\.ts$',
        ],
        reachable: true,
      },
    },
    {
      name: 'worker-role-no-inbound-api',
      severity: 'error',
      comment:
        'The worker role has no inbound API: no controllers, gateways, RPC server ' +
        'or dashboard, and no cron triggers (the scheduler owns those).',
      from: { path: '^src/roles/worker/' },
      to: {
        path: [...INBOUND_API, '\\.schedule\\.ts$', ...DASHBOARD],
        reachable: true,
      },
    },
    {
      name: 'scheduler-role-only-enqueues',
      severity: 'error',
      comment:
        'The scheduler only triggers: each cron enqueues a job the worker runs. ' +
        'It reaches no inbound API and none of the code that does the work.',
      from: { path: '^src/roles/scheduler/' },
      to: {
        path: [...INBOUND_API, ...BACKGROUND_WORK, ...DASHBOARD],
        reachable: true,
      },
    },
    {
      name: 'crons-only-in-schedules',
      severity: 'error',
      comment:
        'A cron runs wherever its provider is loaded, so @nestjs/schedule is used only ' +
        'by *.schedule.ts files and by the scheduler root, which registers ScheduleModule; ' +
        'only the scheduler role imports either.',
      from: {
        path: '^src/',
        pathNot: [
          '\\.schedule\\.ts$',
          '^src/roles/scheduler/scheduler\\.module\\.ts$',
          TEST_FILES,
        ],
      },
      to: { path: 'node_modules/@nestjs/schedule(/|$)' },
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
