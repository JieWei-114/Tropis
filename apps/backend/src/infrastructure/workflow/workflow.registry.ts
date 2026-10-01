import type { Type } from '@nestjs/common';

/** Workflow types a module starts, and the queue their worker polls. */
export interface WorkflowQueueDefinition {
  /** Unique per process; the worker of this queue runs these types. */
  queue: string;
  workflowTypes: readonly string[];
}

/**
 * A provider whose activities() are the activity implementations of one
 * queue. It is a Nest provider of the feature's worker module, so the
 * activities get their dependencies injected; workflow code reaches them
 * only through the engine.
 */
export interface WorkflowActivityProvider {
  /** Activity name → implementation. */
  activities(): object;
}

/** What the worker of one queue runs. */
export interface WorkflowWorkerDefinition {
  queue: string;
  /** require.resolve() of the workflow definitions file, next to its caller. */
  workflowsPath: string;
  activities: Type<WorkflowActivityProvider>;
}

/** The WorkflowRegistry of the process. */
export const WORKFLOW_QUEUES = Symbol('WORKFLOW_QUEUES');

/** The WorkflowWorkerRegistry of the process. */
export const WORKFLOW_WORKERS = Symbol('WORKFLOW_WORKERS');

export class UnknownWorkflowTypeError extends Error {
  constructor(type: string) {
    super(
      `Unknown workflow type ${JSON.stringify(type)}; register it with WorkflowModule.forFeature`,
    );
    this.name = 'UnknownWorkflowTypeError';
  }
}

/** Workflow type → queue, from every WorkflowModule.forFeature. */
export class WorkflowRegistry {
  private readonly queues = new Map<string, string>();

  register(definition: WorkflowQueueDefinition): void {
    for (const type of definition.workflowTypes) {
      const existing = this.queues.get(type);
      if (existing && existing !== definition.queue) {
        throw new Error(
          `Workflow type ${type} is registered on ${existing} and ${definition.queue}`,
        );
      }
      this.queues.set(type, definition.queue);
    }
  }

  queueOf(type: string): string {
    const queue = this.queues.get(type);
    if (!queue) throw new UnknownWorkflowTypeError(type);
    return queue;
  }
}

/** The worker definitions from every WorkflowWorkerModule.forFeature. */
export class WorkflowWorkerRegistry {
  private readonly workers = new Map<string, WorkflowWorkerDefinition>();

  register(definition: WorkflowWorkerDefinition): void {
    const existing = this.workers.get(definition.queue);
    if (existing && existing !== definition) {
      throw new Error(`Workflow queue ${definition.queue} has two workers`);
    }
    this.workers.set(definition.queue, definition);
  }

  all(): WorkflowWorkerDefinition[] {
    return [...this.workers.values()];
  }
}
