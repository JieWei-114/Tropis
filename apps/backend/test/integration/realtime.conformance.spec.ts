import Redis from 'ioredis';
import { RedisRealtimeAdapter } from '../../src/infrastructure/realtime/adapters/redis/redis-realtime.adapter';
import { realtimeChannelKey } from '../../src/infrastructure/realtime/realtime.rooms';
import { describeRealtimePort } from '../../src/infrastructure/realtime/__tests__/realtime.conformance';
import { startGatewayNode } from '../../src/infrastructure/realtime/__tests__/realtime-harness';
import { describeWithDocker } from './docker';
import { startRedis, waitUntil, type StartedContainer } from './containers';

jest.setTimeout(240_000);

describeWithDocker('Realtime conformance (redis)')(
  'Realtime conformance (redis)',
  () => {
    let container: StartedContainer;

    beforeAll(async () => {
      container = await startRedis();
    });

    afterAll(async () => {
      await container?.stop();
    });

    describeRealtimePort('redis', async () => {
      const key = realtimeChannelKey({ app: 'tropis', env: 'conformance' });
      const connect = () =>
        new Redis({ host: container.host, port: container.port(6379) });
      const clients = [connect(), connect(), connect()];
      const [gatewayA, gatewayB, worker] = clients.map(
        (redis) => new RedisRealtimeAdapter(redis, key),
      );
      const nodes = [
        await startGatewayNode(gatewayA),
        await startGatewayNode(gatewayB),
      ];
      return {
        publisher: worker,
        nodes,
        ready: () =>
          waitUntil(
            'gateway subscriptions',
            async () => Number(await clients[2].pubsub('NUMPAT')) >= 2,
            10_000,
          ),
        async teardown() {
          await Promise.all(nodes.map((n) => n.close()));
          await Promise.all([gatewayA, gatewayB, worker].map((a) => a.close()));
          clients.forEach((c) => c.disconnect());
        },
      };
    });
  },
);
