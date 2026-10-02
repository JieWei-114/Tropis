import { DynamicModule, Global, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { AEROSPIKE_CLIENT } from '../../connections/aerospike/aerospike.constants';
import { DisabledCacheAdapter } from '../../cache/adapters/disabled/disabled-cache.adapter';
import { CacheClient } from '../../cache/cache.client';
import { CacheHealthIndicator } from '../../cache/cache.health';
import { CacheModule } from '../../cache/cache.module';
import { CACHE } from '../../cache/cache.port';
import { DisabledDedupAdapter } from '../../dedup/adapters/disabled/disabled-dedup.adapter';
import { RedisDedupAdapter } from '../../dedup/adapters/redis/redis-dedup.adapter';
import { DedupModule } from '../../dedup/dedup.module';
import { DEDUP } from '../../dedup/dedup.port';
import { DisabledGraphAdapter } from '../../graph/adapters/disabled/disabled-graph.adapter';
import { GraphClient } from '../../graph/graph.client';
import { GraphModule } from '../../graph/graph.module';
import { GRAPH } from '../../graph/graph.port';
import { AerospikeKvAdapter } from '../../kv/adapters/aerospike/aerospike-kv.adapter';
import { DisabledKvAdapter } from '../../kv/adapters/disabled/disabled-kv.adapter';
import { RedisKvAdapter } from '../../kv/adapters/redis/redis-kv.adapter';
import { KvModule } from '../../kv/kv.module';
import { KV } from '../../kv/kv.port';
import { DisabledLockAdapter } from '../../lock/adapters/disabled/disabled-lock.adapter';
import { RedisLockAdapter } from '../../lock/adapters/redis/redis-lock.adapter';
import { LockModule } from '../../lock/lock.module';
import { LOCK } from '../../lock/lock.port';
import { DisabledMessagingAdapter } from '../../messaging/adapters/disabled/disabled-messaging.adapter';
import { KafkaMessagingAdapter } from '../../messaging/adapters/kafka/kafka-messaging.adapter';
import { PulsarMessagingAdapter } from '../../messaging/adapters/pulsar/pulsar-messaging.adapter';
import { MessagingHealthIndicator } from '../../messaging/messaging.health';
import { MessagingModule } from '../../messaging/messaging.module';
import { MESSAGING } from '../../messaging/messaging.port';
import { PULSAR_CLIENT } from '../../connections/pulsar/pulsar.constants';
import { DisabledRateLimitAdapter } from '../../ratelimit/adapters/disabled/disabled-ratelimit.adapter';
import { RedisRateLimitAdapter } from '../../ratelimit/adapters/redis/redis-ratelimit.adapter';
import { RateLimitModule } from '../../ratelimit/ratelimit.module';
import { RATE_LIMIT } from '../../ratelimit/ratelimit.port';
import { REDIS_CLIENT } from '../../connections/redis/redis.constants';
import { LogMailAdapter } from '../../mail/adapters/log/log-mail.adapter';
import { SmtpMailAdapter } from '../../mail/adapters/smtp/smtp-mail.adapter';
import { MailModule } from '../../mail/mail.module';
import { MAIL } from '../../mail/mail.port';
import { DisabledObjectsAdapter } from '../../objects/adapters/disabled/disabled-objects.adapter';
import { MinioObjectsAdapter } from '../../objects/adapters/minio/minio-objects.adapter';
import { ObjectsModule } from '../../objects/objects.module';
import { OBJECTS } from '../../objects/objects.port';
import { DisabledOlapAdapter } from '../../olap/adapters/disabled/disabled-olap.adapter';
import { OlapClient } from '../../olap/olap.client';
import { OlapModule } from '../../olap/olap.module';
import { OLAP } from '../../olap/olap.port';
import { OpaPolicyAdapter } from '../../policy/adapters/opa/opa-policy.adapter';
import { PolicyModule } from '../../policy/policy.module';
import { POLICY } from '../../policy/policy.port';
import { RELATIONAL } from '../../relational/relational.port';
import { DisabledSearchAdapter } from '../../search/adapters/disabled/disabled-search.adapter';
import { SearchClient } from '../../search/search.client';
import { SearchModule } from '../../search/search.module';
import { SEARCH } from '../../search/search.port';
import { EnvSecretsAdapter } from '../../secrets/adapters/env/env-secrets.adapter';
import { VaultSecretsAdapter } from '../../secrets/adapters/vault/vault-secrets.adapter';
import { SecretsModule } from '../../secrets/secrets.module';
import { SECRETS } from '../../secrets/secrets.port';
import { InprocessSigningAdapter } from '../../signing/adapters/inprocess/inprocess-signing.adapter';
import { NativeSigningAdapter } from '../../signing/adapters/native/native-signing.adapter';
import { SigningModule } from '../../signing/signing.module';
import { SIGNING } from '../../signing/signing.port';
import { DisabledVectorAdapter } from '../../vector/adapters/disabled/disabled-vector.adapter';
import { VectorClient } from '../../vector/vector.client';
import { VectorModule } from '../../vector/vector.module';
import { VECTOR } from '../../vector/vector.port';
import { temporalClientProvider } from '../../workflow/adapters/temporal/temporal-client.provider';
import { OlapHealthIndicator } from '../../olap/olap.health';
import { envValidationSchema } from '../../../config/env.validation';

function mockEmptyModule(name: string) {
  const { Module } =
    jest.requireActual<typeof import('@nestjs/common')>('@nestjs/common');
  const cls = { [name]: class {} }[name];
  Module({})(cls);
  return cls;
}

// The real connection modules open sockets; the stubs below stand in for
// what they export.
jest.mock('../../connections/redis/redis-connection.module', () => ({
  ...jest.requireActual<Record<string, unknown>>(
    '../../connections/redis/redis.constants',
  ),
  RedisConnectionModule: mockEmptyModule('RedisConnectionModule'),
}));
jest.mock('../../connections/pulsar/pulsar-connection.module', () => ({
  ...jest.requireActual<Record<string, unknown>>(
    '../../connections/pulsar/pulsar.constants',
  ),
  PulsarConnectionModule: mockEmptyModule('PulsarConnectionModule'),
}));
jest.mock('../../connections/aerospike/aerospike-connection.module', () => ({
  ...jest.requireActual<Record<string, unknown>>(
    '../../connections/aerospike/aerospike.constants',
  ),
  AerospikeConnectionModule: mockEmptyModule('AerospikeConnectionModule'),
}));
jest.mock('../../relational/relational.module', () => {
  const RelationalModule = mockEmptyModule('RelationalModule');
  return {
    RelationalModule: Object.assign(RelationalModule, {
      forRoot: () => ({ module: RelationalModule }),
    }),
  };
});

/** Every schema default, as the validated config provides them. */
const DEFAULTS = envValidationSchema.validate(
  { JWT_SECRET: 'x'.repeat(32) },
  { abortEarly: false },
).value as Record<string, unknown>;

/** Stand-ins for the shared connection modules the capability modules reuse. */
@Global()
@Module({
  providers: [
    {
      provide: REDIS_CLIENT,
      useValue: { ping: () => Promise.resolve('PONG') },
    },
    { provide: AEROSPIKE_CLIENT, useValue: null },
    { provide: PULSAR_CLIENT, useValue: {} },
    { provide: RELATIONAL, useValue: { query: () => Promise.resolve([]) } },
  ],
  exports: [REDIS_CLIENT, AEROSPIKE_CLIENT, PULSAR_CLIENT, RELATIONAL],
})
class ConnectionsStub {}

async function resolve(
  module: DynamicModule | (new () => unknown),
  token: unknown,
  env: Record<string, string>,
): Promise<unknown> {
  const ref = await Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({
        isGlobal: true,
        ignoreEnvFile: true,
        ignoreEnvVars: true,
        load: [() => ({ ...DEFAULTS, ...env })],
      }),
      ConnectionsStub,
      module,
    ],
  }).compile();
  const value: unknown = ref.get<unknown>(token as string, { strict: false });
  await ref.close();
  return value;
}

describe('capability modules select the configured adapter', () => {
  it.each([
    [CacheModule.forRoot(), CACHE, 'CACHE_ADAPTER', 'redis', CacheClient],
    [
      CacheModule.forRoot(),
      CACHE,
      'CACHE_ADAPTER',
      'disabled',
      DisabledCacheAdapter,
    ],
    [KvModule.forRoot(), KV, 'KV_ADAPTER', 'redis', RedisKvAdapter],
    [KvModule.forRoot(), KV, 'KV_ADAPTER', 'aerospike', AerospikeKvAdapter],
    [KvModule.forRoot(), KV, 'KV_ADAPTER', 'disabled', DisabledKvAdapter],
    [LockModule.forRoot(), LOCK, 'LOCK_ADAPTER', 'redis', RedisLockAdapter],
    [
      LockModule.forRoot(),
      LOCK,
      'LOCK_ADAPTER',
      'disabled',
      DisabledLockAdapter,
    ],
    [
      RateLimitModule.forRoot(),
      RATE_LIMIT,
      'RATE_LIMIT_ADAPTER',
      'redis',
      RedisRateLimitAdapter,
    ],
    [
      RateLimitModule.forRoot(),
      RATE_LIMIT,
      'RATE_LIMIT_ADAPTER',
      'disabled',
      DisabledRateLimitAdapter,
    ],
    [DedupModule.forRoot(), DEDUP, 'DEDUP_ADAPTER', 'redis', RedisDedupAdapter],
    [
      DedupModule.forRoot(),
      DEDUP,
      'DEDUP_ADAPTER',
      'disabled',
      DisabledDedupAdapter,
    ],
    [GraphModule.forRoot(), GRAPH, 'GRAPH_ADAPTER', 'neo4j', GraphClient],
    [
      GraphModule.forRoot(),
      GRAPH,
      'GRAPH_ADAPTER',
      'disabled',
      DisabledGraphAdapter,
    ],
    [
      MessagingModule.forRoot(),
      MESSAGING,
      'MESSAGING_ADAPTER',
      'pulsar',
      PulsarMessagingAdapter,
    ],
    [
      MessagingModule.forRoot(),
      MESSAGING,
      'MESSAGING_ADAPTER',
      'kafka',
      KafkaMessagingAdapter,
    ],
    [
      MessagingModule.forRoot(),
      MESSAGING,
      'MESSAGING_ADAPTER',
      'disabled',
      DisabledMessagingAdapter,
    ],
    [
      VectorModule.forRoot(),
      VECTOR,
      'VECTOR_ADAPTER',
      'pgvector',
      VectorClient,
    ],
    [
      VectorModule.forRoot(),
      VECTOR,
      'VECTOR_ADAPTER',
      'disabled',
      DisabledVectorAdapter,
    ],
    [
      SearchModule.forRoot(),
      SEARCH,
      'SEARCH_ADAPTER',
      'elasticsearch',
      SearchClient,
    ],
    [
      SearchModule.forRoot(),
      SEARCH,
      'SEARCH_ADAPTER',
      'disabled',
      DisabledSearchAdapter,
    ],
    [OlapModule.forRoot(), OLAP, 'OLAP_ADAPTER', 'clickhouse', OlapClient],
    [
      OlapModule.forRoot(),
      OLAP,
      'OLAP_ADAPTER',
      'disabled',
      DisabledOlapAdapter,
    ],
    [
      ObjectsModule.forRoot(),
      OBJECTS,
      'OBJECTS_ADAPTER',
      'minio',
      MinioObjectsAdapter,
    ],
    [
      ObjectsModule.forRoot(),
      OBJECTS,
      'OBJECTS_ADAPTER',
      'disabled',
      DisabledObjectsAdapter,
    ],
    [
      SecretsModule.forRoot(),
      SECRETS,
      'SECRETS_ADAPTER',
      'vault',
      VaultSecretsAdapter,
    ],
    [
      SecretsModule.forRoot(),
      SECRETS,
      'SECRETS_ADAPTER',
      'env',
      EnvSecretsAdapter,
    ],
    [MailModule.forRoot(), MAIL, 'MAIL_ADAPTER', 'smtp', SmtpMailAdapter],
    [MailModule.forRoot(), MAIL, 'MAIL_ADAPTER', 'log', LogMailAdapter],
    [
      SigningModule.forRoot(),
      SIGNING,
      'SIGNING_ADAPTER',
      'inprocess',
      InprocessSigningAdapter,
    ],
    [
      SigningModule.forRoot(),
      SIGNING,
      'SIGNING_ADAPTER',
      'native',
      NativeSigningAdapter,
    ],
  ] as const)('%#: %s=%s', async (module, token, variable, value, expected) => {
    const env = { [variable]: value, NEO4J_PASSWORD: 'unused' };
    expect(await resolve(module, token, env)).toBeInstanceOf(expected);
  });

  it('defaults every capability to its production adapter', async () => {
    expect(await resolve(SecretsModule.forRoot(), SECRETS, {})).toBeInstanceOf(
      VaultSecretsAdapter,
    );
    expect(await resolve(MailModule.forRoot(), MAIL, {})).toBeInstanceOf(
      SmtpMailAdapter,
    );
    expect(await resolve(SigningModule.forRoot(), SIGNING, {})).toBeInstanceOf(
      InprocessSigningAdapter,
    );
    expect(await resolve(SearchModule.forRoot(), SEARCH, {})).toBeInstanceOf(
      SearchClient,
    );
    expect(await resolve(PolicyModule.forRoot(), POLICY, {})).toBeInstanceOf(
      OpaPolicyAdapter,
    );
  });

  it('does not connect to Temporal when the workflow adapter is disabled', async () => {
    const config = {
      get: (key: string, fallback?: unknown) =>
        key === 'WORKFLOW_ADAPTER' ? 'disabled' : fallback,
    };
    const holder = await temporalClientProvider.useFactory(config as never);
    await expect(holder.get()).resolves.toBeNull();
    expect(holder.current()).toBeNull();
  });

  it('defaults graph to disabled and rejects unknown selectors', async () => {
    expect(await resolve(GraphModule.forRoot(), GRAPH, {})).toBeInstanceOf(
      DisabledGraphAdapter,
    );
    await expect(
      resolve(CacheModule.forRoot(), CACHE, { CACHE_ADAPTER: 'memcached' }),
    ).rejects.toThrow(/Unsupported CACHE_ADAPTER/);
  });

  it('exposes health indicators that report disabled adapters as healthy', async () => {
    const env = { CACHE_ADAPTER: 'disabled', MESSAGING_ADAPTER: 'disabled' };
    const cache = (await resolve(
      CacheModule.forRoot(),
      CacheHealthIndicator,
      env,
    )) as CacheHealthIndicator;
    await expect(cache.isHealthy()).resolves.toEqual({
      cache: { status: 'up', adapter: 'disabled', disabled: true },
    });
    const messaging = (await resolve(
      MessagingModule.forRoot(),
      MessagingHealthIndicator,
      env,
    )) as MessagingHealthIndicator;
    await expect(messaging.isHealthy('broker')).resolves.toEqual({
      broker: { status: 'up', adapter: 'disabled', disabled: true },
    });
    const olap = (await resolve(OlapModule.forRoot(), OlapHealthIndicator, {
      OLAP_ADAPTER: 'disabled',
    })) as OlapHealthIndicator;
    await expect(olap.isHealthy('clickhouse')).resolves.toEqual({
      clickhouse: { status: 'up', adapter: 'disabled', disabled: true },
    });
  });
});
