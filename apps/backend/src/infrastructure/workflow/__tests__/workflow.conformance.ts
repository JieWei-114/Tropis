import {
  TENANT_A,
  TENANT_B,
  uniqueId,
  type ConformanceTarget,
} from '../../capability/__tests__/conformance-helpers';
import type { CapabilityStatus } from '../../capability';
import type { WorkflowExecution, WorkflowPort } from '../workflow.port';
import { WorkflowRegistry } from '../workflow.registry';

/** Registered by conformanceRegistry(); no worker polls its queue, so its executions stay running. */
export const CONFORMANCE_WORKFLOW_TYPE = 'conformanceWorkflow';
export const CONFORMANCE_WORKFLOW_QUEUE = 'conformance-workflow';

export function conformanceRegistry(): WorkflowRegistry {
  const registry = new WorkflowRegistry();
  registry.register({
    queue: CONFORMANCE_WORKFLOW_QUEUE,
    workflowTypes: [CONFORMANCE_WORKFLOW_TYPE],
  });
  return registry;
}

export interface WorkflowConformanceTargets {
  /** A port over a reachable engine whose registry is conformanceRegistry(). */
  live?: ConformanceTarget<WorkflowPort> & {
    /** Visibility (count, list) may lag a start; polled up to this long. */
    visibilityLagMs?: number;
  };
  /** Ports that cannot run workflows, with the health status each reports. */
  unavailable: Array<
    ConformanceTarget<WorkflowPort> & {
      label: string;
      status: Exclude<CapabilityStatus, 'up'>;
    }
  >;
}

async function eventually<T>(
  read: () => Promise<T>,
  done: (value: T) => boolean,
  timeoutMs: number,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let value = await read();
  while (!done(value) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 250));
    value = await read();
  }
  return value;
}

/**
 * Behaviour every WorkflowPort adapter must share: a started execution is
 * visible under its tenant-local id to its tenant only, ids are tenant-local
 * (two tenants may reuse one) but unique among running executions of a
 * tenant, counts and lists are tenant-scoped, a type no module registered or
 * that is not an identifier is refused, and a port that cannot run workflows
 * says so through isAvailable() and health() and rejects every call.
 */
export function describeWorkflowPort(
  adapter: string,
  targets: WorkflowConformanceTargets,
): void {
  describe(`WorkflowPort conformance: ${adapter}`, () => {
    const live = targets.live;
    if (live) {
      describe('with a reachable engine', () => {
        let workflow: WorkflowPort;
        const lagMs = live.visibilityLagMs ?? 0;

        beforeAll(async () => {
          workflow = await live.make();
        });

        afterAll(async () => {
          await live.teardown?.(workflow);
        });

        it('reports up and available', async () => {
          expect((await workflow.health()).status).toBe('up');
          expect(workflow.isAvailable()).toBe(true);
        });

        it('starts an execution and describes it by its tenant-local id', async () => {
          const id = `wf-${uniqueId()}`;
          const before = Date.now();
          await expect(
            workflow.start(TENANT_A, CONFORMANCE_WORKFLOW_TYPE, [{ n: 1 }], {
              workflowId: id,
            }),
          ).resolves.toEqual({ workflowId: id });

          const execution = await workflow.describe(TENANT_A, id);
          expect(execution).toMatchObject({
            workflowId: id,
            status: 'RUNNING',
            closeTime: null,
          });
          expect(execution?.startTime).toEqual(expect.any(Number));
          expect(execution!.startTime!).toBeGreaterThanOrEqual(before - 5_000);
        });

        it('generates an id when none is given', async () => {
          const { workflowId } = await workflow.start(
            TENANT_A,
            CONFORMANCE_WORKFLOW_TYPE,
            [],
          );
          expect(workflowId).toEqual(expect.any(String));
          await expect(
            workflow.describe(TENANT_A, workflowId),
          ).resolves.toMatchObject({ workflowId });
        });

        it('describes an unknown id as null', async () => {
          await expect(
            workflow.describe(TENANT_A, `missing-${uniqueId()}`),
          ).resolves.toBeNull();
        });

        it("hides one tenant's execution from another", async () => {
          const id = `wf-${uniqueId()}`;
          await workflow.start(TENANT_A, CONFORMANCE_WORKFLOW_TYPE, [], {
            workflowId: id,
          });
          await expect(workflow.describe(TENANT_B, id)).resolves.toBeNull();
        });

        it('lets two tenants use the same id', async () => {
          const id = `wf-${uniqueId()}`;
          await workflow.start(TENANT_A, CONFORMANCE_WORKFLOW_TYPE, [], {
            workflowId: id,
          });
          await expect(
            workflow.start(TENANT_B, CONFORMANCE_WORKFLOW_TYPE, [], {
              workflowId: id,
            }),
          ).resolves.toEqual({ workflowId: id });
          await expect(workflow.describe(TENANT_B, id)).resolves.toMatchObject({
            workflowId: id,
            status: 'RUNNING',
          });
        });

        it('rejects a second start of a running id in one tenant', async () => {
          const id = `wf-${uniqueId()}`;
          await workflow.start(TENANT_A, CONFORMANCE_WORKFLOW_TYPE, [], {
            workflowId: id,
          });
          await expect(
            workflow.start(TENANT_A, CONFORMANCE_WORKFLOW_TYPE, [], {
              workflowId: id,
            }),
          ).rejects.toThrow();
        });

        it("counts and lists only the tenant's executions, newest first", async () => {
          const ids = [`wf-${uniqueId()}`, `wf-${uniqueId()}`];
          for (const id of ids) {
            await workflow.start(TENANT_B, CONFORMANCE_WORKFLOW_TYPE, [], {
              workflowId: id,
            });
            await new Promise((r) => setTimeout(r, 20));
          }
          const a = await workflow.start(
            TENANT_A,
            CONFORMANCE_WORKFLOW_TYPE,
            [],
            { workflowId: `wf-${uniqueId()}` },
          );

          const listed = await eventually<WorkflowExecution[]>(
            () => workflow.list(TENANT_B, CONFORMANCE_WORKFLOW_TYPE, 100),
            (rows) => ids.every((id) => rows.some((r) => r.workflowId === id)),
            lagMs,
          );
          const listedIds = listed.map((r) => r.workflowId);
          expect(listedIds).toEqual(expect.arrayContaining(ids));
          expect(listedIds).not.toContain(a.workflowId);
          expect(listedIds.indexOf(ids[1])).toBeLessThan(
            listedIds.indexOf(ids[0]),
          );
          const starts = listed.map((r) => r.startTime ?? 0);
          expect(starts).toEqual([...starts].sort((x, y) => y - x));

          const running = await eventually(
            () =>
              workflow.count(TENANT_B, CONFORMANCE_WORKFLOW_TYPE, 'running'),
            (n) => n >= listed.length,
            lagMs,
          );
          expect(running).toBe(
            listed.filter((r) => r.status === 'RUNNING').length,
          );
          await expect(
            workflow.count(TENANT_B, CONFORMANCE_WORKFLOW_TYPE, 'completed'),
          ).resolves.toBe(0);
        });

        it('caps a list at the limit', async () => {
          for (let i = 0; i < 3; i++) {
            await workflow.start(TENANT_A, CONFORMANCE_WORKFLOW_TYPE, [], {
              workflowId: `wf-${uniqueId()}`,
            });
          }
          const rows = await eventually(
            () => workflow.list(TENANT_A, CONFORMANCE_WORKFLOW_TYPE, 100),
            (r) => r.length >= 3,
            lagMs,
          );
          expect(rows.length).toBeGreaterThanOrEqual(3);
          await expect(
            workflow.list(TENANT_A, CONFORMANCE_WORKFLOW_TYPE, 2),
          ).resolves.toHaveLength(2);
        });

        it('refuses a type no module registered', async () => {
          await expect(
            workflow.start(TENANT_A, 'unregisteredWorkflow', []),
          ).rejects.toThrow(/register/i);
        });

        it('refuses a type that is not an identifier in visibility queries', async () => {
          await expect(
            workflow.count(TENANT_A, "x' OR 1=1 --", 'running'),
          ).rejects.toThrow(/Invalid workflow type/);
          await expect(
            workflow.list(TENANT_A, "x' OR 1=1 --", 10),
          ).rejects.toThrow(/Invalid workflow type/);
        });
      });
    }

    for (const target of targets.unavailable) {
      describe(`when ${target.label}`, () => {
        let workflow: WorkflowPort;

        beforeAll(async () => {
          workflow = await target.make();
        });

        afterAll(async () => {
          await target.teardown?.(workflow);
        });

        it(`is unavailable and reports ${target.status}`, async () => {
          expect(workflow.isAvailable()).toBe(false);
          expect((await workflow.health()).status).toBe(target.status);
        });

        it('rejects every call instead of pretending to succeed', async () => {
          await expect(
            workflow.start(TENANT_A, CONFORMANCE_WORKFLOW_TYPE, []),
          ).rejects.toThrow();
          await expect(workflow.describe(TENANT_A, 'any')).rejects.toThrow();
          await expect(
            workflow.count(TENANT_A, CONFORMANCE_WORKFLOW_TYPE, 'running'),
          ).rejects.toThrow();
          await expect(
            workflow.list(TENANT_A, CONFORMANCE_WORKFLOW_TYPE, 10),
          ).rejects.toThrow();
        });
      });
    }
  });
}
