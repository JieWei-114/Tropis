import { DynamicModule, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BullmqJobsAdapter } from './adapters/bullmq/bullmq-jobs.adapter';
import { bullmqConnection } from './adapters/bullmq/bullmq-options';
import { BullmqQueues } from './adapters/bullmq/bullmq-queues';
import { JobsHealthIndicator } from './jobs.health';
import { JOBS, type JobsPort } from './jobs.port';
import {
  JOB_QUEUES,
  JobQueueRegistry,
  type JobQueueDefinition,
} from './jobs.registry';

@Module({})
class JobsFeatureModule {}

/**
 * Provides JOBS (JobsPort) over BullMQ, the only adapter: running without
 * queues is not a supported mode, so there is no `disabled` selector.
 *
 * forRoot() is the producer side; a module that owns queues imports
 * forFeature(queues) instead, which registers them and re-exports forRoot().
 * The worker role adds JobsWorkersModule, the local `all` role
 * JobsDashboardModule.
 */
@Module({})
export class JobsModule {
  private static root?: DynamicModule;

  static forRoot(): DynamicModule {
    JobsModule.root ??= {
      module: JobsModule,
      providers: [
        { provide: JOB_QUEUES, useFactory: () => new JobQueueRegistry() },
        {
          provide: JOBS,
          inject: [ConfigService, JOB_QUEUES],
          useFactory: (
            config: ConfigService,
            registry: JobQueueRegistry,
          ): JobsPort =>
            new BullmqJobsAdapter(
              registry,
              new BullmqQueues(bullmqConnection(config)),
            ),
        },
        JobsHealthIndicator,
      ],
      exports: [JOBS, JOB_QUEUES, JobsHealthIndicator],
    };
    return JobsModule.root;
  }

  /** Declares the queues a module owns, in every role that imports it. */
  static forFeature(queues: readonly JobQueueDefinition[]): DynamicModule {
    const root = JobsModule.forRoot();
    return {
      module: JobsFeatureModule,
      imports: [root],
      providers: [
        {
          provide: Symbol(`JOB_QUEUES:${queues.map((q) => q.name).join(',')}`),
          inject: [JOB_QUEUES],
          useFactory: (registry: JobQueueRegistry) => {
            for (const queue of queues) registry.register(queue);
            return true;
          },
        },
      ],
      exports: [root],
    };
  }
}
