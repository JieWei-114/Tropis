import type { OnApplicationShutdown } from '@nestjs/common';
import { WorkflowNotFoundError, type Client } from '@temporalio/client';
import { isTenantId, type TenantId } from '../../../../common/keyspace';
import {
  capabilityDown,
  probeCapability,
  type CapabilityHealth,
} from '../../../capability';
import type {
  StartWorkflowOptions,
  WorkflowExecution,
  WorkflowPort,
  WorkflowStatusFilter,
} from '../../workflow.port';
import type { WorkflowRegistry } from '../../workflow.registry';
import type { TemporalClientHolder } from './temporal-client.holder';

const DEFAULT_EXECUTION_TIMEOUT_MS = 10 * 60 * 1000;

const STATUS_QUERY: Record<WorkflowStatusFilter, string> = {
  running: 'Running',
  completed: 'Completed',
};

/** Workflow type names are code identifiers; anything else is rejected before it reaches a visibility query. */
const WORKFLOW_TYPE_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

function assertWorkflowType(type: string): void {
  if (!WORKFLOW_TYPE_PATTERN.test(type)) {
    throw new Error(`Invalid workflow type ${JSON.stringify(type)}`);
  }
}

/**
 * Engine-side id prefix of a tenant's executions: `t.<tenantId>:`. A tenant
 * id never contains ':', so no tenant's prefix is a prefix of another's, and
 * the id pattern keeps it safe inside a quoted visibility query.
 */
export function tenantWorkflowPrefix(tenantId: TenantId): string {
  if (!isTenantId(tenantId)) {
    throw new Error(`Invalid tenant id ${JSON.stringify(tenantId)}`);
  }
  return `t.${tenantId}:`;
}

interface ExecutionInfo {
  workflowId: string;
  status: { name: string };
  startTime?: Date;
  closeTime?: Date;
}

function toExecution(prefix: string, wf: ExecutionInfo): WorkflowExecution {
  return {
    workflowId: wf.workflowId.slice(prefix.length),
    status: wf.status.name,
    startTime: wf.startTime ? wf.startTime.getTime() : null,
    closeTime: wf.closeTime ? wf.closeTime.getTime() : null,
  };
}

/**
 * WorkflowPort over the Temporal client. Each execution's engine id is its
 * tenant-local id behind the tenant prefix, and every visibility query is
 * filtered by that prefix, so one tenant never lists, counts or describes
 * another's executions. While Temporal is unreachable the port reports
 * unavailable; the client holder reconnects when it is back.
 */
export class TemporalWorkflowAdapter
  implements WorkflowPort, OnApplicationShutdown
{
  constructor(
    private readonly clients: TemporalClientHolder,
    private readonly registry: WorkflowRegistry,
  ) {}

  isAvailable(): boolean {
    if (this.clients.current()) return true;
    void this.clients.get();
    return false;
  }

  async start(
    tenantId: TenantId,
    workflowType: string,
    args: unknown[],
    options: StartWorkflowOptions = {},
  ): Promise<{ workflowId: string }> {
    const prefix = tenantWorkflowPrefix(tenantId);
    const taskQueue = this.registry.queueOf(workflowType);
    const workflowId = options.workflowId ?? `${workflowType}-${Date.now()}`;
    const client = await this.require();
    await client.workflow.start(workflowType, {
      taskQueue,
      workflowId: `${prefix}${workflowId}`,
      args,
      // Cap total workflow lifetime — prevents zombie workflows if activities
      // exhaust retries and leave the execution in a stuck/running state.
      workflowExecutionTimeout:
        options.executionTimeoutMs ?? DEFAULT_EXECUTION_TIMEOUT_MS,
    });
    return { workflowId };
  }

  async describe(
    tenantId: TenantId,
    workflowId: string,
  ): Promise<WorkflowExecution | null> {
    const prefix = tenantWorkflowPrefix(tenantId);
    const client = await this.require();
    try {
      const info = await client.workflow
        .getHandle(`${prefix}${workflowId}`)
        .describe();
      return toExecution(prefix, info);
    } catch (err) {
      if (err instanceof WorkflowNotFoundError) return null;
      throw err;
    }
  }

  async count(
    tenantId: TenantId,
    workflowType: string,
    status: WorkflowStatusFilter,
  ): Promise<number> {
    assertWorkflowType(workflowType);
    const prefix = tenantWorkflowPrefix(tenantId);
    const client = await this.require();
    const result = await client.workflow.count(
      `WorkflowType = '${workflowType}' AND ExecutionStatus = '${STATUS_QUERY[status]}' AND WorkflowId STARTS_WITH '${prefix}'`,
    );
    return result.count;
  }

  async list(
    tenantId: TenantId,
    workflowType: string,
    limit: number,
  ): Promise<WorkflowExecution[]> {
    assertWorkflowType(workflowType);
    const prefix = tenantWorkflowPrefix(tenantId);
    const client = await this.require();
    const out: WorkflowExecution[] = [];
    const iter = client.workflow.list({
      query: `WorkflowType = '${workflowType}' AND WorkflowId STARTS_WITH '${prefix}'`,
    });
    for await (const wf of iter) {
      // The query already filters by tenant; this keeps the fence even if a
      // visibility store ignored the clause.
      if (!wf.workflowId.startsWith(prefix)) continue;
      out.push(toExecution(prefix, wf));
      if (out.length >= limit) break;
    }
    // Sort in memory (newest first) — dev visibility rejects ORDER BY.
    return out.sort((a, b) => (b.startTime ?? 0) - (a.startTime ?? 0));
  }

  /** Confirms the Temporal frontend is reachable, reconnecting when due. */
  async health(): Promise<CapabilityHealth> {
    const client = await this.clients.get();
    if (!client) return capabilityDown('temporal', 'Temporal is not available');
    return probeCapability('temporal', () =>
      client.connection.ensureConnected(),
    );
  }

  async onApplicationShutdown(): Promise<void> {
    await this.clients.close();
  }

  private async require(): Promise<Client> {
    const client = await this.clients.get();
    if (!client) {
      throw new Error('Temporal is not available in this environment');
    }
    return client;
  }
}
