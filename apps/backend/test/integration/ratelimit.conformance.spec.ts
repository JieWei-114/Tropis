import Redis from 'ioredis';
import { RedisRateLimitAdapter } from '../../src/infrastructure/ratelimit/adapters/redis/redis-ratelimit.adapter';
import { describeRateLimitPort } from '../../src/infrastructure/ratelimit/__tests__/ratelimit.conformance';
import { describeWithDocker } from './docker';
import { startRedis, type StartedContainer } from './containers';

jest.setTimeout(240_000);

describeWithDocker('Rate limit conformance (redis)')(
  'Rate limit conformance (redis)',
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

    describeRateLimitPort('redis', {
      make: () => new RedisRateLimitAdapter(redis),
    });
  },
);
