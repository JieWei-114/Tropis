import Redis from 'ioredis';
import { AerospikeKvAdapter } from '../../src/infrastructure/kv/adapters/aerospike/aerospike-kv.adapter';
import type { AerospikeKvClient } from '../../src/infrastructure/kv/adapters/aerospike/aerospike-kv.adapter';
import { RedisKvAdapter } from '../../src/infrastructure/kv/adapters/redis/redis-kv.adapter';
import { describeKvPort } from '../../src/infrastructure/kv/__tests__/kv.conformance';
import { describeWithDocker } from './docker';
import {
  startContainer,
  startRedis,
  waitUntil,
  type StartedContainer,
} from './containers';

jest.setTimeout(240_000);

describeWithDocker('KV conformance (redis)')('KV conformance (redis)', () => {
  let container: StartedContainer;
  let redis: Redis;

  beforeAll(async () => {
    container = await startRedis();
    redis = new Redis({ host: container.host, port: container.port(6379) });
  });

  afterAll(async () => {
    redis?.disconnect();
    await container?.stop();
  });

  describeKvPort('redis', { make: () => new RedisKvAdapter(redis) });
});

describeWithDocker('KV conformance (aerospike)')(
  'KV conformance (aerospike)',
  () => {
    let container: StartedContainer;
    let client: (AerospikeKvClient & { close(): void }) | undefined;

    beforeAll(async () => {
      container = startContainer({
        image: 'aerospike/aerospike-server:8.1.2.4',
        label: 'aerospike',
        ports: [3000],
      });
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const Aerospike = require('aerospike') as {
        client(config: object): AerospikeKvClient & {
          connect(): Promise<unknown>;
          close(): void;
        };
      };
      await waitUntil(
        'aerospike',
        async () => {
          const candidate = Aerospike.client({
            hosts: `${container.host}:${container.port(3000)}`,
            connTimeoutMs: 2_000,
            // Readiness polling fails by design until the server is up.
            log: { level: -1 },
          });
          try {
            await candidate.connect();
            // A write proves the namespace is ready, not just the socket.
            const probe = new AerospikeKvAdapter(candidate);
            await probe.set(
              'probe:probe:global:kv:probe:ready:v1' as never,
              true,
              { ttlSeconds: 60 },
            );
            client = candidate;
            return true;
          } catch (err) {
            candidate.close();
            throw err;
          }
        },
        120_000,
        container,
      );
    });

    afterAll(async () => {
      client?.close();
      await container?.stop();
    });

    describeKvPort('aerospike', {
      make: () => new AerospikeKvAdapter(client!),
    });
  },
);
