import Redis from 'ioredis';
import { RedisCacheStore } from '../../src/infrastructure/cache/adapters/redis/redis-cache.store';
import { CacheClient } from '../../src/infrastructure/cache/cache.client';
import { describeCachePort } from '../../src/infrastructure/cache/__tests__/cache.conformance';
import { describeWithDocker } from './docker';
import { startRedis, type StartedContainer } from './containers';

jest.setTimeout(240_000);

describeWithDocker('Cache conformance (redis)')(
  'Cache conformance (redis)',
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

    describeCachePort('redis', {
      make: () => new CacheClient(new RedisCacheStore(redis)),
    });
  },
);
