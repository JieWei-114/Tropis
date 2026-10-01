import Redis from 'ioredis';
import { RedisLockAdapter } from '../../src/infrastructure/lock/adapters/redis/redis-lock.adapter';
import { describeLockPort } from '../../src/infrastructure/lock/__tests__/lock.conformance';
import { describeWithDocker } from './docker';
import { startRedis, type StartedContainer } from './containers';

jest.setTimeout(240_000);

describeWithDocker('Lock conformance (redis)')(
  'Lock conformance (redis)',
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

    describeLockPort('redis', { make: () => new RedisLockAdapter(redis) });
  },
);
