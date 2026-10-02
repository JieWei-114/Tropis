import * as Joi from 'joi';
import {
  DEFAULT_CORS_ORIGIN,
  DEFAULT_NATIVE_OAUTH_REDIRECT,
  isNativeCallbackUrl,
  nativeOAuthRedirectList,
} from './cors.constants';

const TENANT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;

const API_KEYS_MAP = Joi.object().pattern(
  Joi.string(),
  Joi.object({
    secret: Joi.string().min(1).required(),
    tenantId: Joi.string().pattern(TENANT_ID_PATTERN).required(),
  }),
);

// Validated on startup — app refuses to start if required vars are missing or invalid.
// This catches misconfigured deployments immediately instead of failing at runtime.
export const envValidationSchema = Joi.object({
  // HTTP
  PORT: Joi.number().default(3100),
  // Public RPC listener (Connect, gRPC and gRPC-Web on one port).
  RPC_PUBLIC_PORT: Joi.number().default(50051),
  // Internal RPC tier listener (tropis.<domain>.internal.v1) — separate port so
  // exposure is decided at the network layer; ClusterIP-only in production.
  RPC_INTERNAL_PORT: Joi.number().default(50061),
  // Ops listener on every role: /livez, /readyz, /metrics. Never exposed
  // through the ingress.
  OPS_PORT: Joi.number().default(9464),
  NODE_ENV: Joi.string()
    .valid('development', 'production', 'test')
    .default('development'),
  // gRPC server reflection (grpcurl/grpcui schema discovery). Reflection
  // reveals the full API schema — auto-on outside production, explicit
  // opt-in (GRPC_REFLECTION=true) required in production. Gating rationale:
  // config/grpc-reflection.ts.
  GRPC_REFLECTION: Joi.boolean().default(false),
  // A comma-separated list of WEB origins. The packaged clients' origins are
  // constants appended in cors.constants.ts, not configuration.
  CORS_ORIGIN: Joi.string()
    .default(DEFAULT_CORS_ORIGIN)
    .custom((value: string, helpers) => {
      const parts = value
        .split(',')
        .map((v) => v.trim())
        .filter(Boolean);
      if (!parts.length) return helpers.error('any.invalid');
      for (const part of parts) {
        const { error } = Joi.string().uri().validate(part);
        if (error) return helpers.error('any.invalid');
      }
      return value;
    })
    .messages({
      'any.invalid':
        'CORS_ORIGIN must be a comma-separated list of absolute URLs',
    }),
  LOG_LEVEL: Joi.string()
    .valid('trace', 'debug', 'info', 'warn', 'error')
    .default('info'),
  // `json` writes one JSON record per line outside production too (read
  // before configuration loads, from the environment only).
  LOG_FORMAT: Joi.string().optional().allow(''),

  // Auth — no default for JWT_SECRET: forces an explicit value in every environment
  JWT_SECRET: Joi.string().min(32).required(),
  JWT_EXPIRES_IN: Joi.string().default('15m'),
  // Secure flag of the refresh cookie; default: on unless NODE_ENV is
  // development or test.
  COOKIE_SECURE: Joi.boolean().optional(),
  OAUTH_TENANT_ID: Joi.string().pattern(TENANT_ID_PATTERN).allow('').optional(),
  // Custom-scheme URLs an OAuth sign-in may return a native shell to
  // (comma-separated, exact match; empty disables native OAuth).
  NATIVE_OAUTH_REDIRECTS: Joi.string()
    .allow('')
    .default(DEFAULT_NATIVE_OAUTH_REDIRECT)
    .custom((value: string, helpers) =>
      nativeOAuthRedirectList(value).every(isNativeCallbackUrl)
        ? value
        : helpers.error('any.invalid'),
    )
    .messages({
      'any.invalid':
        'NATIVE_OAUTH_REDIRECTS must be comma-separated custom-scheme URLs without a fragment (e.g. tropis://auth/callback)',
    }),

  // OAuth providers — a provider without both client values answers its
  // routes with OAUTH_NOT_CONFIGURED (501).
  GOOGLE_CLIENT_ID: Joi.string().allow('').default(''),
  GOOGLE_CLIENT_SECRET: Joi.string().allow('').default(''),
  GOOGLE_CALLBACK_URL: Joi.string()
    .uri()
    .allow('')
    .default('http://localhost:3100/api/auth/google/callback'),
  GITHUB_CLIENT_ID: Joi.string().allow('').default(''),
  GITHUB_CLIENT_SECRET: Joi.string().allow('').default(''),
  GITHUB_CALLBACK_URL: Joi.string()
    .uri()
    .allow('')
    .default('http://localhost:3100/api/auth/github/callback'),

  // Self sign-up (UserService/Create without a token): per client address
  // and per tenant, in one window.
  SIGNUP_RATE_LIMIT_IP: Joi.number().integer().min(1).default(10),
  SIGNUP_RATE_LIMIT_TENANT: Joi.number().integer().min(1).default(200),
  SIGNUP_RATE_LIMIT_WINDOW_S: Joi.number().integer().min(1).default(3600),

  // Request signing (docs/api-conventions.md) — JSON map
  // { keyId: { secret, tenantId } }; a signed request acts for its key's
  // tenant. Default '{}' disables the signed tier; may come from Vault.
  API_KEYS: Joi.string()
    .default('{}')
    .custom((value: string, helpers) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(value);
      } catch {
        return helpers.error('any.invalid');
      }
      const { error } = API_KEYS_MAP.validate(parsed);
      return error ? helpers.error('any.invalid') : value;
    }, 'API key map validation'),

  // Internal gRPC tier service identity (docs/api-conventions.md).
  // Unset → internal RPCs return UNIMPLEMENTED. Production = mTLS/SPIFFE.
  SERVICE_TOKEN: Joi.string().allow('').default(''),

  // MongoDB
  MONGODB_URI: Joi.string().uri().default('mongodb://localhost:27017/tropis'),

  // Redis
  REDIS_HOST: Joi.string().default('localhost'),
  REDIS_PORT: Joi.number().default(6379),
  REDIS_PASSWORD: Joi.string().optional().allow(''),

  // Keyspace (src/common/keyspace) — the {app}:{env} prefix of every cache,
  // kv, lock, ratelimit and dedup key. KEYSPACE_ENV defaults to NODE_ENV.
  KEYSPACE_APP: Joi.string()
    .pattern(/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/)
    .default('tropis'),
  KEYSPACE_ENV: Joi.string()
    .pattern(/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/)
    .default(Joi.ref('NODE_ENV')),

  // Capability adapters (src/infrastructure/<capability>/). `disabled` makes
  // every call throw CapabilityDisabledError and reports health `disabled`.
  CACHE_ADAPTER: Joi.string().valid('redis', 'disabled').default('redis'),
  KV_ADAPTER: Joi.string()
    .valid('redis', 'aerospike', 'disabled')
    .default('redis'),
  LOCK_ADAPTER: Joi.string().valid('redis', 'disabled').default('redis'),
  RATE_LIMIT_ADAPTER: Joi.string().valid('redis', 'disabled').default('redis'),
  DEDUP_ADAPTER: Joi.string().valid('redis', 'disabled').default('redis'),
  // Off by default: the graph server is an optional compose profile.
  GRAPH_ADAPTER: Joi.string().valid('neo4j', 'disabled').default('disabled'),
  // `local` delivers only to sockets of the publishing process (single node).
  REALTIME_ADAPTER: Joi.string().valid('redis', 'local').default('redis'),
  // The one engine that writes analytics events to OLAP: `node` (the
  // AnalyticsProcessor) or `flink` (services/flink).
  STREAM_ENGINE: Joi.string().valid('node', 'flink').default('node'),
  VECTOR_ADAPTER: Joi.string()
    .valid('pgvector', 'disabled')
    .default('pgvector'),
  SEARCH_ADAPTER: Joi.string()
    .valid('elasticsearch', 'disabled')
    .default('elasticsearch'),
  OLAP_ADAPTER: Joi.string()
    .valid('clickhouse', 'disabled')
    .default('clickhouse'),
  OBJECTS_ADAPTER: Joi.string().valid('minio', 'disabled').default('minio'),
  WORKFLOW_ADAPTER: Joi.string()
    .valid('temporal', 'disabled')
    .default('temporal'),
  // `env` reads secrets from the environment only; encrypt() then returns
  // null and callers redact instead of storing plaintext.
  SECRETS_ADAPTER: Joi.string().valid('vault', 'env').default('vault'),
  // Vault (SECRETS_ADAPTER=vault). Without VAULT_ADDR nothing is read from
  // Vault. Authentication: VAULT_ROLE_ID + VAULT_SECRET_ID (AppRole), else
  // VAULT_TOKEN. These are read before validation, from the environment only.
  VAULT_ADDR: Joi.string().uri().optional().allow(''),
  VAULT_TOKEN: Joi.string().optional().allow(''),
  VAULT_ROLE_ID: Joi.string().optional().allow(''),
  VAULT_SECRET_ID: Joi.string().optional().allow(''),
  VAULT_SECRET_PATH: Joi.string().default('secret/data/tropis'),
  // `log` writes each message to the log instead of sending it (development).
  MAIL_ADAPTER: Joi.string().valid('smtp', 'log').default('smtp'),
  // `native` verifies signatures through the signing service (services/rust/signing),
  // which must be configured with the same API_KEYS.
  SIGNING_ADAPTER: Joi.string()
    .valid('inprocess', 'native')
    .default('inprocess'),
  SIGNING_SERVICE_URL: Joi.string().uri().default('http://localhost:50052'),

  // Neo4j (used when GRAPH_ADAPTER=neo4j)
  NEO4J_URI: Joi.string().default('bolt://localhost:7687'),
  NEO4J_USER: Joi.string().default('neo4j'),
  NEO4J_PASSWORD: Joi.string().optional().allow(''),

  // ClickHouse
  CLICKHOUSE_HOST: Joi.string().default('http://localhost:8123'),
  CLICKHOUSE_USER: Joi.string().default('default'),
  CLICKHOUSE_PASSWORD: Joi.string().optional().allow(''),
  CLICKHOUSE_DATABASE: Joi.string().default('logs'),

  // Messaging — selects the MessagingPort adapter (src/infrastructure/messaging/).
  // Adding a broker means implementing the port, registering it in
  // messaging.module.ts and adding its name to the valid() list here.
  MESSAGING_ADAPTER: Joi.string()
    .valid('pulsar', 'kafka', 'disabled')
    .default('pulsar'),
  // Redelivery of a failed message: the delay doubles from the base up to
  // the ceiling (kept below the 60 s ack timeout), then it is dead-lettered.
  MESSAGING_MAX_REDELIVERIES: Joi.number().integer().min(0).default(10),
  MESSAGING_REDELIVERY_DELAY_MS: Joi.number().integer().min(100).default(1000),
  MESSAGING_MAX_REDELIVERY_DELAY_MS: Joi.number()
    .integer()
    .min(100)
    .max(50000)
    .default(30000),

  // Kafka (used when MESSAGING_ADAPTER=kafka) — comma-separated host:port list.
  KAFKA_BROKERS: Joi.string().default('localhost:9092'),
  KAFKA_CLIENT_ID: Joi.string().default('tropis-backend'),

  // Outbox: days a dispatched or skipped row is kept before it is deleted.
  OUTBOX_RETENTION_DAYS: Joi.number().integer().min(1).default(7),

  // Pulsar
  PULSAR_SERVICE_URL: Joi.string().default('pulsar://localhost:6650'),

  // Aerospike
  AEROSPIKE_HOSTS: Joi.string()
    .pattern(/^[^,:\s]+:\d+(,[^,:\s]+:\d+)*$/)
    .default('localhost:3000'),

  // PostgreSQL + pgvector
  POSTGRES_HOST: Joi.string().default('localhost'),
  POSTGRES_PORT: Joi.number().default(5432),
  POSTGRES_USER: Joi.string().default('tropis'),
  POSTGRES_PASSWORD: Joi.string().allow('').default('tropis_dev_password'),
  POSTGRES_DB: Joi.string().default('tropis'),
  // TLS to Postgres; the server certificate is always verified, against
  // POSTGRES_SSL_CA (PEM, `\n` escapes allowed) when set.
  POSTGRES_SSL: Joi.string().valid('true', 'false').default('false'),
  POSTGRES_SSL_CA: Joi.string().optional().allow(''),
  // Connection retries at boot (a slow-starting Postgres).
  POSTGRES_RETRY_ATTEMPTS: Joi.number().integer().min(0).default(30),
  POSTGRES_RETRY_DELAY: Joi.number().integer().min(0).default(3000),
  // Schema sync from entities. Local experiments only: production schema
  // comes from the migrations.
  TYPEORM_SYNC: Joi.boolean().default(false),

  // Elasticsearch
  ELASTICSEARCH_NODE: Joi.string().default('http://localhost:9200'),
  ELASTICSEARCH_USERNAME: Joi.string().optional().allow(''),
  ELASTICSEARCH_PASSWORD: Joi.string().optional().allow(''),

  // MinIO (S3-compatible object storage)
  MINIO_ENDPOINT: Joi.string().default('localhost'),
  MINIO_PORT: Joi.number().default(9900),
  MINIO_USE_SSL: Joi.string().valid('true', 'false').default('false'),
  MINIO_ACCESS_KEY: Joi.string().default('minioadmin'),
  MINIO_SECRET_KEY: Joi.string().default('minioadmin123'),
  MINIO_BUCKET: Joi.string().default('app-uploads'),

  // SMTP (Mailpit locally)
  SMTP_HOST: Joi.string().default('localhost'),
  SMTP_PORT: Joi.number().default(1025),
  SMTP_USER: Joi.string().optional().allow(''),
  SMTP_PASS: Joi.string().optional().allow(''),
  SMTP_FROM: Joi.string().default('noreply@tropis.local'),

  // OpenTelemetry
  OTEL_SERVICE_NAME: Joi.string().default('tropis-backend'),
  OTEL_EXPORTER_OTLP_ENDPOINT: Joi.string().optional(),
  SERVICE_VERSION: Joi.string().optional().allow(''),
  SERVICE_ROLE: Joi.string()
    .valid('all', 'public', 'private', 'worker', 'scheduler')
    .optional(),

  // OPA
  OPA_URL: Joi.string().default('http://localhost:8181'),
  OPA_TOKEN: Joi.string().optional().allow(''),

  // Temporal
  TEMPORAL_ADDRESS: Joi.string().default('localhost:7233'),
  TEMPORAL_NAMESPACE: Joi.string().default('default'),
  // At most 30 days; the workflow's execution timeout is this plus a margin.
  ONBOARDING_FOLLOWUP_DELAY_MS: Joi.number()
    .integer()
    .min(0)
    .max(30 * 24 * 60 * 60 * 1000)
    .default(30000),

  // Rate limiting. The auth limit is deliberately far tighter than the global
  // one; raise it only where many real sign-ins share one source IP (browser
  // E2E, load tests, a stack behind a single NAT).
  RATE_LIMIT_TTL_MS: Joi.number().integer().min(1000).default(60000),
  RATE_LIMIT_DEFAULT: Joi.number().integer().min(1).default(100),
  RATE_LIMIT_AUTH: Joi.number().integer().min(1).default(10),
  RATE_LIMIT_REFRESH: Joi.number().integer().min(1).default(60),
});
