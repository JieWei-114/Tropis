import { DynamicModule, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { selectAdapter } from '../capability';
import { DisabledWorkflowAdapter } from './adapters/disabled/disabled-workflow.adapter';
import type { TemporalClientHolder } from './adapters/temporal/temporal-client.holder';
import { TemporalWorkflowAdapter } from './adapters/temporal/temporal-workflow.adapter';
import { TemporalWorkflowModule } from './adapters/temporal/temporal-workflow.module';
import { TEMPORAL_CLIENT } from './adapters/temporal/temporal.constants';
import { WorkflowHealthIndicator } from './workflow.health';
import {
  WORKFLOW,
  WORKFLOW_ADAPTERS,
  type WorkflowPort,
} from './workflow.port';
import {
  WORKFLOW_QUEUES,
  WorkflowRegistry,
  type WorkflowQueueDefinition,
} from './workflow.registry';

@Module({})
class WorkflowFeatureModule {}

/**
 * Provides WORKFLOW (WorkflowPort), adapter chosen by WORKFLOW_ADAPTER.
 * `temporal` (default) degrades to unavailable while the server is down and
 * reconnects when it is back.
 *
 * A module that starts workflows imports forFeature({ queue, workflowTypes })
 * to declare which queue each type runs on; the worker side of that queue is
 * WorkflowWorkerModule.forFeature, in the module's worker module.
 */
@Module({})
export class WorkflowModule {
  private static root?: DynamicModule;

  static forRoot(): DynamicModule {
    WorkflowModule.root ??= {
      module: WorkflowModule,
      imports: [TemporalWorkflowModule],
      providers: [
        { provide: WORKFLOW_QUEUES, useFactory: () => new WorkflowRegistry() },
        {
          provide: WORKFLOW,
          inject: [ConfigService, TEMPORAL_CLIENT, WORKFLOW_QUEUES],
          useFactory: (
            config: ConfigService,
            clients: TemporalClientHolder,
            registry: WorkflowRegistry,
          ): WorkflowPort => {
            const adapter = selectAdapter(
              'WORKFLOW_ADAPTER',
              config.get<string>('WORKFLOW_ADAPTER'),
              WORKFLOW_ADAPTERS,
              'temporal',
            );
            if (adapter === 'disabled') return new DisabledWorkflowAdapter();
            return new TemporalWorkflowAdapter(clients, registry);
          },
        },
        WorkflowHealthIndicator,
      ],
      exports: [WORKFLOW, WORKFLOW_QUEUES, WorkflowHealthIndicator],
    };
    return WorkflowModule.root;
  }

  static forFeature(definition: WorkflowQueueDefinition): DynamicModule {
    const root = WorkflowModule.forRoot();
    return {
      module: WorkflowFeatureModule,
      imports: [root],
      providers: [
        {
          provide: Symbol(`WORKFLOW_QUEUES:${definition.queue}`),
          inject: [WORKFLOW_QUEUES],
          useFactory: (registry: WorkflowRegistry) => {
            registry.register(definition);
            return true;
          },
        },
      ],
      exports: [root],
    };
  }
}
