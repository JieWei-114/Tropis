import { Injectable, Inject } from '@nestjs/common';
import { Client, WorkflowHandle } from '@temporalio/client';
import { TEMPORAL_CLIENT, TEMPORAL_TASK_QUEUE } from './temporal.constants';

export interface StartWorkflowOptions {
  workflowId?: string;
  taskQueue?: string;
  /** Hard ceiling on total workflow runtime including all retries. Default 10 minutes. */
  workflowExecutionTimeoutMs?: number;
}

@Injectable()
export class TemporalService {
  private static readonly DEFAULT_WORKFLOW_EXEC_MS = 10 * 60 * 1000;

  constructor(@Inject(TEMPORAL_CLIENT) private readonly client: Client) {}

  async startWorkflow<T extends unknown[], R>(
    workflowType: string,
    args: T,
    options: StartWorkflowOptions = {},
  ): Promise<WorkflowHandle<(...a: T) => Promise<R>>> {
    const workflowId = options.workflowId ?? `${workflowType}-${Date.now()}`;

    const handle = await this.client.workflow.start(workflowType, {
      taskQueue: options.taskQueue ?? TEMPORAL_TASK_QUEUE,
      workflowId,
      args,
      // Cap total workflow lifetime — prevents zombie workflows if activities
      // exhaust retries and leave the execution in a stuck/running state.
      workflowExecutionTimeout:
        options.workflowExecutionTimeoutMs ??
        TemporalService.DEFAULT_WORKFLOW_EXEC_MS,
    });
    return handle as WorkflowHandle<(...a: T) => Promise<R>>;
  }

  getWorkflowHandle(workflowId: string) {
    return this.client.workflow.getHandle(workflowId);
  }

  async close() {
    await this.client.connection.close();
  }

  /** Confirms the Temporal frontend is reachable (re-runs getSystemInfo if needed). */
  async ping(): Promise<void> {
    await this.client.connection.ensureConnected();
  }
}
