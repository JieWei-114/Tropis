import { WorkflowNotFoundError, type Client } from '@temporalio/client';
import { toTenantId } from '../../../common/keyspace';
import { CapabilityDisabledError } from '../../capability';
import { DisabledWorkflowAdapter } from '../adapters/disabled/disabled-workflow.adapter';
import { TemporalWorkflowAdapter } from '../adapters/temporal/temporal-workflow.adapter';
import { TemporalClientHolder } from '../adapters/temporal/temporal-client.holder';
import {
  UnknownWorkflowTypeError,
  WorkflowRegistry,
} from '../workflow.registry';

const ONBOARDING_WORKFLOW = 'testOnboardingWorkflow';
const QUEUE = 'test-queue';

function registry(): WorkflowRegistry {
  const r = new WorkflowRegistry();
  r.register({ queue: QUEUE, workflowTypes: [ONBOARDING_WORKFLOW] });
  return r;
}

const ACME = toTenantId('acme');

function fakeClient(prefix = 't.acme:') {
  const listed = [
    {
      workflowId: `${prefix}onboarding-a`,
      status: { name: 'COMPLETED' },
      startTime: new Date(1000),
      closeTime: new Date(2000),
    },
    {
      workflowId: `${prefix}onboarding-b`,
      status: { name: 'RUNNING' },
      startTime: new Date(3000),
      closeTime: undefined,
    },
    {
      workflowId: 't.globex:onboarding-c',
      status: { name: 'RUNNING' },
      startTime: new Date(4000),
      closeTime: undefined,
    },
  ];
  return {
    workflow: {
      start: jest.fn((_type: string, opts: { workflowId: string }) =>
        Promise.resolve({ workflowId: opts.workflowId }),
      ),
      count: jest.fn().mockResolvedValue({ count: 4 }),
      list: jest.fn(() =>
        (async function* () {
          for (const wf of listed) yield wf;
        })(),
      ),
      getHandle: jest.fn(() => ({ describe: jest.fn() })),
    },
    connection: {
      ensureConnected: jest.fn().mockResolvedValue(undefined),
      close: jest.fn().mockResolvedValue(undefined),
    },
  };
}

const holderOf = (client: unknown) =>
  new TemporalClientHolder(() => Promise.resolve(client as Client));

async function adapterOver(client: unknown) {
  const holder = holderOf(client);
  await holder.get();
  return new TemporalWorkflowAdapter(holder, registry());
}

describe('TemporalWorkflowAdapter', () => {
  // Reproduces the leak: executions were started and listed without a
  // tenant, so any signed-in user saw every tenant's onboarding workflows.
  it('starts a workflow under the tenant prefix on its registered queue with a 10-minute ceiling', async () => {
    const client = fakeClient();
    const adapter = await adapterOver(client);

    await expect(
      adapter.start(ACME, ONBOARDING_WORKFLOW, [{ userId: 'u' }], {
        workflowId: 'onboarding-u',
      }),
    ).resolves.toEqual({ workflowId: 'onboarding-u' });
    expect(client.workflow.start).toHaveBeenCalledWith(ONBOARDING_WORKFLOW, {
      taskQueue: QUEUE,
      workflowId: 't.acme:onboarding-u',
      args: [{ userId: 'u' }],
      workflowExecutionTimeout: 10 * 60 * 1000,
    });
  });

  it('counts by type, status and tenant through a visibility query', async () => {
    const client = fakeClient();
    const adapter = await adapterOver(client);

    await expect(
      adapter.count(ACME, ONBOARDING_WORKFLOW, 'running'),
    ).resolves.toBe(4);
    expect(client.workflow.count).toHaveBeenCalledWith(
      `WorkflowType = '${ONBOARDING_WORKFLOW}' AND ExecutionStatus = 'Running' AND WorkflowId STARTS_WITH 't.acme:'`,
    );
  });

  it('refuses a workflow type that could alter the visibility query', async () => {
    const adapter = await adapterOver(fakeClient());
    await expect(
      adapter.count(ACME, "x' OR '1'='1", 'running'),
    ).rejects.toThrow(/Invalid workflow type/);
  });

  it("lists only the tenant's executions, newest first, with tenant-local ids", async () => {
    const client = fakeClient();
    const adapter = await adapterOver(client);
    const list = await adapter.list(ACME, ONBOARDING_WORKFLOW, 5);
    expect(client.workflow.list).toHaveBeenCalledWith({
      query: `WorkflowType = '${ONBOARDING_WORKFLOW}' AND WorkflowId STARTS_WITH 't.acme:'`,
    });
    expect(list.map((w) => w.workflowId)).toEqual([
      'onboarding-b',
      'onboarding-a',
    ]);
    expect(list[1]).toEqual({
      workflowId: 'onboarding-a',
      status: 'COMPLETED',
      startTime: 1000,
      closeTime: 2000,
    });
    await expect(
      adapter.list(ACME, ONBOARDING_WORKFLOW, 1),
    ).resolves.toHaveLength(1);
  });

  it('describes an execution by its tenant-scoped id, and an unknown one as null', async () => {
    const client = fakeClient();
    client.workflow.getHandle.mockReturnValue({
      describe: jest
        .fn()
        .mockRejectedValue(new WorkflowNotFoundError('gone', 'id', undefined)),
    });
    const adapter = await adapterOver(client);
    await expect(adapter.describe(ACME, 'id')).resolves.toBeNull();
    expect(client.workflow.getHandle).toHaveBeenCalledWith('t.acme:id');
  });

  it('is unavailable and reports down while Temporal is unreachable', async () => {
    const adapter = new TemporalWorkflowAdapter(
      new TemporalClientHolder(null),
      registry(),
    );
    expect(adapter.isAvailable()).toBe(false);
    await expect(adapter.start(ACME, ONBOARDING_WORKFLOW, [])).rejects.toThrow(
      /not available/,
    );
    await expect(adapter.health()).resolves.toMatchObject({
      status: 'down',
      adapter: 'temporal',
    });
  });

  it('recovers from a boot-time failure once Temporal comes up', async () => {
    let now = 0;
    const client = fakeClient();
    const connect = jest
      .fn()
      .mockRejectedValueOnce(new Error('ECONNREFUSED'))
      .mockResolvedValue(client);
    const holder = new TemporalClientHolder(connect, 10_000, () => now);
    await expect(holder.get()).resolves.toBeNull();
    const adapter = new TemporalWorkflowAdapter(holder, registry());

    expect(adapter.isAvailable()).toBe(false);
    await expect(adapter.health()).resolves.toMatchObject({ status: 'down' });
    expect(connect).toHaveBeenCalledTimes(1);

    now = 10_000;
    await expect(adapter.health()).resolves.toMatchObject({ status: 'up' });
    expect(adapter.isAvailable()).toBe(true);
    await expect(
      adapter.start(ACME, ONBOARDING_WORKFLOW, []),
    ).resolves.toMatchObject({ workflowId: expect.any(String) });
    expect(connect).toHaveBeenCalledTimes(2);
  });

  it('shares one connect attempt between concurrent callers', async () => {
    let release!: (c: unknown) => void;
    const connect = jest.fn(
      () => new Promise<Client>((r) => (release = r as never)),
    );
    const holder = new TemporalClientHolder(connect);
    const a = holder.get();
    const b = holder.get();
    release(fakeClient());
    await Promise.all([a, b]);
    expect(connect).toHaveBeenCalledTimes(1);
  });

  it('closes the connection on shutdown', async () => {
    const client = fakeClient();
    await (await adapterOver(client)).onApplicationShutdown();
    expect(client.connection.close).toHaveBeenCalled();
  });
});

describe('WorkflowRegistry', () => {
  it('rejects a start of a type no module registered', async () => {
    const adapter = await adapterOver(fakeClient());
    await expect(adapter.start(ACME, 'unregistered', [])).rejects.toThrow(
      UnknownWorkflowTypeError,
    );
  });

  it('refuses one type on two queues', () => {
    const r = registry();
    expect(() =>
      r.register({ queue: 'other', workflowTypes: [ONBOARDING_WORKFLOW] }),
    ).toThrow(/registered on/);
  });
});

describe('DisabledWorkflowAdapter', () => {
  it('is unavailable, rejects calls and reports disabled', async () => {
    const adapter = new DisabledWorkflowAdapter();
    expect(adapter.isAvailable()).toBe(false);
    await expect(adapter.start()).rejects.toBeInstanceOf(
      CapabilityDisabledError,
    );
    await expect(adapter.health()).resolves.toMatchObject({
      status: 'disabled',
    });
  });
});
