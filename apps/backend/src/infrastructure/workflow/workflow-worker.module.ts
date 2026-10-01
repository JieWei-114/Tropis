import { DynamicModule, Module } from '@nestjs/common';
import { TemporalWorkerService } from './adapters/temporal/temporal-worker.service';
import { TemporalWorkflowModule } from './adapters/temporal/temporal-workflow.module';
import {
  WORKFLOW_WORKERS,
  WorkflowWorkerRegistry,
  type WorkflowWorkerDefinition,
} from './workflow.registry';

@Module({})
class WorkflowWorkerFeatureModule {}

/**
 * Worker role: executes workflows and activities. forRoot() is the worker of
 * the process, in the worker role root; a module whose workflows run here
 * imports forFeature({ queue, workflowsPath, activities }) from its own
 * worker module.
 */
@Module({})
export class WorkflowWorkerModule {
  private static root?: DynamicModule;

  static forRoot(): DynamicModule {
    WorkflowWorkerModule.root ??= {
      module: WorkflowWorkerModule,
      imports: [TemporalWorkflowModule],
      providers: [
        {
          provide: WORKFLOW_WORKERS,
          useFactory: () => new WorkflowWorkerRegistry(),
        },
        TemporalWorkerService,
      ],
      exports: [WORKFLOW_WORKERS],
    };
    return WorkflowWorkerModule.root;
  }

  static forFeature(definition: WorkflowWorkerDefinition): DynamicModule {
    const root = WorkflowWorkerModule.forRoot();
    return {
      module: WorkflowWorkerFeatureModule,
      imports: [root],
      providers: [
        {
          provide: Symbol(`WORKFLOW_WORKERS:${definition.queue}`),
          inject: [WORKFLOW_WORKERS],
          useFactory: (registry: WorkflowWorkerRegistry) => {
            registry.register(definition);
            return true;
          },
        },
      ],
    };
  }
}
