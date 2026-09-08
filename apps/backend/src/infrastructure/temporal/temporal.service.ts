import { Injectable, Inject } from '@nestjs/common';
import { Client, WorkflowHandle } from '@temporalio/client';
import {
  TEMPORAL_CLIENT,
  TEMPORAL_TASK_QUEUE,
  ONBOARDING_WORKFLOW,
} from './temporal.constants';

export interface OnboardingWorkflowInfo {
  workflowId: string;
  userId: string;
  status: string;
  startTime: number | null;
  closeTime: number | null;
}

export interface StartWorkflowOptions {
  workflowId?: string;
  taskQueue?: string;
  /** Hard ceiling on total workflow runtime including all retries. Default 10 minutes. */
  workflowExecutionTimeoutMs?: number;
}

@Injectable()
export class TemporalService {
  private static readonly DEFAULT_WORKFLOW_EXEC_MS = 10 * 60 * 1000;

  constructor(
    @Inject(TEMPORAL_CLIENT) private readonly client: Client | null,
  ) {}

  /** Whether Temporal is connected; workflow features degrade when false. */
  get available(): boolean {
    return this.client !== null;
  }

  private require(): Client {
    if (!this.client) {
      throw new Error('Temporal is not available in this environment');
    }
    return this.client;
  }

  async startWorkflow<T extends unknown[], R>(
    workflowType: string,
    args: T,
    options: StartWorkflowOptions = {},
  ): Promise<WorkflowHandle<(...a: T) => Promise<R>>> {
    const workflowId = options.workflowId ?? `${workflowType}-${Date.now()}`;

    const handle = await this.require().workflow.start(workflowType, {
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
    return this.require().workflow.getHandle(workflowId);
  }

  /** Running / completed counts for the onboarding workflow (Stack view). */
  async countOnboarding(): Promise<{ running: number; completed: number }> {
    if (!this.client) return { running: 0, completed: 0 };
    const base = `WorkflowType = '${ONBOARDING_WORKFLOW}'`;
    const [running, completed] = await Promise.all([
      this.client.workflow.count(`${base} AND ExecutionStatus = 'Running'`),
      this.client.workflow.count(`${base} AND ExecutionStatus = 'Completed'`),
    ]);
    return { running: running.count, completed: completed.count };
  }

  /** Recent onboarding workflows, newest first (Users badges + overview). */
  async listOnboarding(limit = 200): Promise<OnboardingWorkflowInfo[]> {
    if (!this.client) return [];
    const out: OnboardingWorkflowInfo[] = [];
    const iter = this.client.workflow.list({
      query: `WorkflowType = '${ONBOARDING_WORKFLOW}'`,
    });
    for await (const wf of iter) {
      out.push({
        workflowId: wf.workflowId,
        userId: wf.workflowId.replace(/^onboarding-/, ''),
        status: wf.status.name,
        startTime: wf.startTime ? wf.startTime.getTime() : null,
        closeTime: wf.closeTime ? wf.closeTime.getTime() : null,
      });
      if (out.length >= limit) break;
    }
    // Sort in memory (newest first) — dev visibility rejects ORDER BY.
    return out.sort((a, b) => (b.startTime ?? 0) - (a.startTime ?? 0));
  }

  async close() {
    if (this.client) {
      await this.client.connection.close();
    }
  }

  /** Confirms the Temporal frontend is reachable (re-runs getSystemInfo if needed). */
  async ping(): Promise<void> {
    await this.require().connection.ensureConnected();
  }
}
