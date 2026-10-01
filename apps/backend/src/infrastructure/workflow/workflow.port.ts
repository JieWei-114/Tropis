import type { TenantId } from '../../common/keyspace';
import type { HealthCheckable } from '../capability';

/**
 * Workflow — durable, long-running processes (timers that survive restarts,
 * retried steps). Business code starts and inspects executions through this
 * port. Each module owns its workflow definitions and activities and
 * registers them (WorkflowModule.forFeature, WorkflowWorkerModule.forFeature);
 * the adapter holds only the engine plumbing.
 *
 * Every execution belongs to one tenant: start, describe, count and list
 * take the TenantId, and an execution of one tenant is invisible to every
 * other. Workflow ids are tenant-local (the adapter scopes them), so two
 * tenants may use the same id.
 */
export const WORKFLOW = Symbol('WORKFLOW');

export interface StartWorkflowOptions {
  /** Stable id within the tenant; starting a second execution with a running id is rejected. */
  workflowId?: string;
  /** Hard ceiling on total runtime including retries. Default 10 minutes. */
  executionTimeoutMs?: number;
}

export interface WorkflowExecution {
  workflowId: string;
  /** Engine status name, e.g. RUNNING, COMPLETED, FAILED. */
  status: string;
  startTime: number | null;
  closeTime: number | null;
}

export type WorkflowStatusFilter = 'running' | 'completed';

export interface WorkflowPort extends HealthCheckable {
  /** False when the engine is unreachable or disabled; callers degrade. */
  isAvailable(): boolean;
  start(
    tenantId: TenantId,
    workflowType: string,
    args: unknown[],
    options?: StartWorkflowOptions,
  ): Promise<{ workflowId: string }>;
  /** The tenant's execution, or null when it has none with that id. */
  describe(
    tenantId: TenantId,
    workflowId: string,
  ): Promise<WorkflowExecution | null>;
  count(
    tenantId: TenantId,
    workflowType: string,
    status: WorkflowStatusFilter,
  ): Promise<number>;
  /** The tenant's recent executions of a type, newest first. */
  list(
    tenantId: TenantId,
    workflowType: string,
    limit: number,
  ): Promise<WorkflowExecution[]>;
}

export const WORKFLOW_ADAPTERS = ['temporal', 'disabled'] as const;
export type WorkflowAdapterName = (typeof WORKFLOW_ADAPTERS)[number];
