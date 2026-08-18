import * as Joi from 'joi';
import { DEFAULT_CORS_ORIGIN } from './cors.constants';

// Validated on startup — app refuses to start if required vars are missing or invalid.
// This catches misconfigured deployments immediately instead of failing at runtime.
export const envValidationSchema = Joi.object({
  // HTTP
  PORT: Joi.number().default(3100),
  GRPC_PORT: Joi.number().default(50051),
  // Internal gRPC tier listener (app.<domain>.internal.v1) — separate port so
  // exposure is decided at the network layer; ClusterIP-only in production.
  GRPC_INTERNAL_PORT: Joi.number().default(50061),
  NODE_ENV: Joi.string()
    .valid('development', 'production', 'test')
    .default('development'),
  // gRPC server reflection (grpcurl/grpcui schema discovery). Reflection
  // reveals the full API schema — auto-on outside production, explicit
  // opt-in (GRPC_REFLECTION=true) required in production. Gating rationale:
  // config/grpc-reflection.ts.
  GRPC_REFLECTION: Joi.boolean().default(false),
  CORS_ORIGIN: Joi.string().uri().default(DEFAULT_CORS_ORIGIN),
  LOG_LEVEL: Joi.string()
    .valid('trace', 'debug', 'info', 'warn', 'error')
    .default('info'),

  // Auth — no default for JWT_SECRET: forces an explicit value in every environment
  JWT_SECRET: Joi.string().min(32).required(),
  JWT_EXPIRES_IN: Joi.string().default('15m'),

  // Request signing (docs/api-conventions.md) — JSON map { keyId: secret }.
  // Default '{}' disables the signed tier; keys may also come from Vault
  // (VaultService merges KV secrets into process.env at bootstrap).
  API_KEYS: Joi.string()
    .default('{}')
    .custom((value: string, helpers) => {
      try {
        JSON.parse(value);
        return value;
      } catch {
        return helpers.error('any.invalid');
      }
    }, 'JSON validation'),

  // Internal gRPC tier service identity (docs/api-conventions.md).
  // Unset → internal RPCs return UNIMPLEMENTED. Production = mTLS/SPIFFE.
  SERVICE_TOKEN: Joi.string().optional().allow(''),

  // MongoDB
  MONGODB_URI: Joi.string().uri().default('mongodb://localhost:27017/tropis'),

  // Redis
  REDIS_HOST: Joi.string().default('localhost'),
  REDIS_PORT: Joi.number().default(6379),
  REDIS_PASSWORD: Joi.string().optional().allow(''),

  // ClickHouse
  CLICKHOUSE_HOST: Joi.string().default('http://localhost:8123'),
  CLICKHOUSE_USER: Joi.string().default('default'),
  CLICKHOUSE_PASSWORD: Joi.string().optional().allow(''),
  CLICKHOUSE_DATABASE: Joi.string().default('logs'),

  // Messaging — selects the MessageBrokerPort adapter (src/infrastructure/messaging/).
  // 'kafka' is a planned future adapter: implement the port, register it in
  // messaging.module.ts, then add it to the valid() list here.
  MESSAGE_BROKER: Joi.string().valid('pulsar').default('pulsar'),

  // Pulsar
  PULSAR_SERVICE_URL: Joi.string().default('pulsar://localhost:6650'),

  // Aerospike
  AEROSPIKE_HOST: Joi.string().default('localhost'),
  AEROSPIKE_PORT: Joi.number().default(3000),

  // PostgreSQL + pgvector
  POSTGRES_HOST: Joi.string().default('localhost'),
  POSTGRES_PORT: Joi.number().default(5432),
  POSTGRES_USER: Joi.string().default('tropis'),
  POSTGRES_PASSWORD: Joi.string().optional().allow(''),
  POSTGRES_DB: Joi.string().default('tropis'),
  POSTGRES_SSL: Joi.string().valid('true', 'false').default('false'),

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

  // SMTP / MailHog
  SMTP_HOST: Joi.string().default('localhost'),
  SMTP_PORT: Joi.number().default(1025),
  SMTP_USER: Joi.string().optional().allow(''),
  SMTP_PASS: Joi.string().optional().allow(''),
  SMTP_FROM: Joi.string().default('noreply@tropis.local'),

  // SMS (optional — stub by default)
  SMS_PROVIDER: Joi.string().valid('stub', 'twilio').default('stub'),

  // OpenTelemetry
  OTEL_SERVICE_NAME: Joi.string().default('nestjs-app'),
  OTEL_EXPORTER_OTLP_ENDPOINT: Joi.string().optional(),

  // OPA
  OPA_URL: Joi.string().default('http://localhost:8181'),

  // Temporal
  TEMPORAL_ADDRESS: Joi.string().default('localhost:7233'),
  TEMPORAL_NAMESPACE: Joi.string().default('default'),
});
