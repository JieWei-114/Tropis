import type { ConfigService } from '@nestjs/config';
import type { DiscoveryService, Reflector } from '@nestjs/core';
import { BullmqJobsAdapter } from '../../src/infrastructure/jobs/adapters/bullmq/bullmq-jobs.adapter';
import { BullmqWorkersService } from '../../src/infrastructure/jobs/adapters/bullmq/bullmq-workers.service';
import { describeJobsPort } from '../../src/infrastructure/jobs/__tests__/jobs.conformance';
import { BullmqQueues } from '../../src/infrastructure/jobs/adapters/bullmq/bullmq-queues';
import { describeWithDocker } from './docker';
import { startRedis, type StartedContainer } from './containers';

jest.setTimeout(240_000);

describeWithDocker('Jobs conformance (bullmq)')(
  'Jobs conformance (bullmq)',
  () => {
    let container: StartedContainer;
    let queues: BullmqQueues | undefined;
    let workers: BullmqWorkersService | undefined;

    beforeAll(async () => {
      container = await startRedis();
    });

    afterAll(async () => {
      await workers?.onModuleDestroy();
      await queues?.close();
      await container?.stop();
    });

    describeJobsPort('bullmq', {
      make: (processors, registry) => {
        const connection = {
          host: container.host,
          port: container.port(6379),
        };
        queues = new BullmqQueues(connection);
        const providers = [...processors].map(([queue, instance]) => ({
          instance,
          metatype: { queue },
        }));
        workers = new BullmqWorkersService(
          { getProviders: () => providers } as unknown as DiscoveryService,
          {
            get: (_key: string, metatype: { queue: string }) => metatype.queue,
          } as unknown as Reflector,
          {
            get: () => undefined,
            getOrThrow: (key: string) =>
              key === 'REDIS_HOST' ? connection.host : connection.port,
          } as unknown as ConfigService,
          registry,
        );
        workers.onApplicationBootstrap();
        return Promise.resolve(new BullmqJobsAdapter(registry, queues));
      },
    });
  },
);
