import type { ConfigService } from '@nestjs/config';
import type { ModuleRef } from '@nestjs/core';

const connect = jest.fn<Promise<unknown>, unknown[]>();
const create = jest.fn<Promise<unknown>, unknown[]>();
jest.mock('@temporalio/worker', () => ({
  NativeConnection: { connect: (...args: unknown[]) => connect(...args) },
  Worker: { create: (...args: unknown[]) => create(...args) },
  Runtime: { install: jest.fn() },
  makeTelemetryFilterString: () => 'WARN',
}));

import {
  TemporalWorkerService,
  WORKER_RETRY_BASE_MS,
} from '../adapters/temporal/temporal-worker.service';
import type { TemporalClientHolder } from '../adapters/temporal/temporal-client.holder';
import { WorkflowWorkerRegistry } from '../workflow.registry';

class Activities {
  activities() {
    return {};
  }
}

function fakeWorker() {
  let fail: (err: Error) => void = () => undefined;
  let finish: () => void = () => undefined;
  const run = new Promise<void>((resolve, reject) => {
    fail = reject;
    finish = resolve;
  });
  return {
    worker: {
      run: () => run,
      getState: () => 'RUNNING',
      shutdown: jest.fn(() => finish()),
    },
    fail,
  };
}

function service(available: () => boolean) {
  const registry = new WorkflowWorkerRegistry();
  registry.register({
    queue: 'q',
    workflowsPath: '/w.js',
    activities: Activities,
  });
  const clients = {
    enabled: true,
    get: () => Promise.resolve(available() ? {} : null),
  } as unknown as TemporalClientHolder;
  return new TemporalWorkerService(
    clients,
    registry,
    { get: () => new Activities() } as unknown as ModuleRef,
    { getOrThrow: () => 'x' } as unknown as ConfigService,
  );
}

describe('TemporalWorkerService', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    connect.mockReset().mockResolvedValue({ close: jest.fn() });
    create.mockReset();
  });
  afterEach(() => jest.useRealTimers());

  it('starts the worker once Temporal comes up after the backend', async () => {
    let up = false;
    const first = fakeWorker();
    create.mockResolvedValue(first.worker);
    const workers = service(() => up);

    workers.onApplicationBootstrap();
    await jest.advanceTimersByTimeAsync(0);
    expect(create).not.toHaveBeenCalled();
    expect(workers.status()).toEqual({ q: 'retrying' });

    up = true;
    await jest.advanceTimersByTimeAsync(WORKER_RETRY_BASE_MS);
    expect(create).toHaveBeenCalledTimes(1);
    expect(workers.status()).toEqual({ q: 'running' });
    await workers.onModuleDestroy();
  });

  it('restarts a worker whose run() fails', async () => {
    const first = fakeWorker();
    const second = fakeWorker();
    create
      .mockResolvedValueOnce(first.worker)
      .mockResolvedValueOnce(second.worker);
    const workers = service(() => true);

    workers.onApplicationBootstrap();
    await jest.advanceTimersByTimeAsync(0);
    expect(workers.status()).toEqual({ q: 'running' });

    first.fail(new Error('poller crashed'));
    await jest.advanceTimersByTimeAsync(0);
    expect(workers.status()).toEqual({ q: 'retrying' });

    await jest.advanceTimersByTimeAsync(WORKER_RETRY_BASE_MS);
    expect(create).toHaveBeenCalledTimes(2);
    expect(workers.status()).toEqual({ q: 'running' });
    await workers.onModuleDestroy();
    expect(second.worker.shutdown).toHaveBeenCalled();
  });

  it('starts nothing when the workflow capability is disabled', () => {
    const registry = new WorkflowWorkerRegistry();
    registry.register({
      queue: 'q',
      workflowsPath: '/w.js',
      activities: Activities,
    });
    const workers = new TemporalWorkerService(
      { enabled: false } as unknown as TemporalClientHolder,
      registry,
      {} as ModuleRef,
      {} as ConfigService,
    );
    workers.onApplicationBootstrap();
    expect(workers.status()).toEqual({});
  });
});
