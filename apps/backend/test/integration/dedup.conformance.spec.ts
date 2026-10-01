import Redis from 'ioredis';
import { RedisDedupAdapter } from '../../src/infrastructure/dedup/adapters/redis/redis-dedup.adapter';
import { describeDedupPort } from '../../src/infrastructure/dedup/__tests__/dedup.conformance';
import { describeWithDocker } from './docker';
import { startRedis, type StartedContainer } from './containers';

jest.setTimeout(240_000);

describeWithDocker('Dedup conformance (redis)')(
  'Dedup conformance (redis)',
  () => {
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

    describeDedupPort('redis', { make: () => new RedisDedupAdapter(redis) });
  },
);
