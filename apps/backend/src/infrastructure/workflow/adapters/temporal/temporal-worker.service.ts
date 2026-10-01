import {
  Inject,
  Injectable,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ModuleRef } from '@nestjs/core';
import { NativeConnection, Worker } from '@temporalio/worker';
import { createLogger } from '../../../../common/observability/logger';
import {
  WORKFLOW_WORKERS,
  type WorkflowWorkerDefinition,
  type WorkflowWorkerRegistry,
} from '../../workflow.registry';
import type { TemporalClientHolder } from './temporal-client.holder';
import { installTemporalRuntime } from './temporal-runtime';
import { TEMPORAL_CLIENT } from './temporal.constants';
import { traceActivityInterceptors } from './temporal-trace-headers';

/** First retry of a failed worker start; doubles per failure up to the cap. */
export const WORKER_RETRY_BASE_MS = 5_000;
export const WORKER_RETRY_MAX_MS = 60_000;

export type WorkerState = 'starting' | 'running' | 'retrying' | 'stopped';

/**
 * Runs one Temporal worker per registered queue (WorkflowWorkerModule
 * .forFeature), in-process: each polls its task queue, executes the
 * workflows bundled from its workflowsPath, and runs the activities of its
 * activity provider. The adapter holds no workflow or activity of its own.
 *
 * Never blocks boot and never gives up: while Temporal is unreachable each
 * worker retries its start with exponential backoff (WORKER_RETRY_BASE_MS up
 * to WORKER_RETRY_MAX_MS), so a Temporal that comes up after the backend is
 * picked up; a worker whose run() fails is logged and started again the same
 * way. With WORKFLOW_ADAPTER=disabled nothing starts.
 */
@Injectable()
export class TemporalWorkerService
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = createLogger('workflow');
  private readonly workers = new Map<string, Worker>();
  private readonly runs = new Set<Promise<void>>();
  private readonly states = new Map<string, WorkerState>();
  private readonly failures = new Map<string, number>();
  private readonly timers = new Set<NodeJS.Timeout>();
  private connection: Promise<NativeConnection> | null = null;
  private stopping = false;

  constructor(
    @Inject(TEMPORAL_CLIENT) private readonly clients: TemporalClientHolder,
    @Inject(WORKFLOW_WORKERS) private readonly registry: WorkflowWorkerRegistry,
    private readonly moduleRef: ModuleRef,
    private readonly config: ConfigService,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.clients.enabled) return;
    const definitions = this.registry.all();
    if (!definitions.length) return;
    installTemporalRuntime();
    for (const definition of definitions) {
      this.states.set(definition.queue, 'starting');
      void this.start(definition);
    }
  }

  /** Each registered queue and whether its worker is polling. */
  status(): Record<string, WorkerState> {
    return Object.fromEntries(this.states);
  }

  async onModuleDestroy(): Promise<void> {
    this.stopping = true;
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    // Temporal's runtime already starts the shutdown on SIGTERM/SIGINT.
    for (const worker of this.workers.values()) {
      if (worker.getState() === 'RUNNING') worker.shutdown();
    }
    await Promise.all([...this.runs]);
    const connection = this.connection;
    this.connection = null;
    await connection?.then((c) => c.close()).catch(() => undefined);
  }

  private connect(): Promise<NativeConnection> {
    this.connection ??= NativeConnection.connect({
      address: this.config.getOrThrow<string>('TEMPORAL_ADDRESS'),
    }).catch((err: unknown) => {
      this.connection = null;
      throw err;
    });
    return this.connection;
  }

  private async start(definition: WorkflowWorkerDefinition): Promise<void> {
    if (this.stopping) return;
    const queue = definition.queue;
    let worker: Worker;
    try {
      if (!(await this.clients.get())) {
        throw new Error('Temporal is not available');
      }
      const provider = this.moduleRef.get(definition.activities, {
        strict: false,
      });
      worker = await Worker.create({
        connection: await this.connect(),
        namespace: this.config.getOrThrow<string>('TEMPORAL_NAMESPACE'),
        taskQueue: queue,
        workflowsPath: definition.workflowsPath,
        activities: provider.activities(),
        interceptors: {
          activity: [traceActivityInterceptors],
          workflowModules: [require.resolve('./temporal-interceptors')],
        },
      });
    } catch (err) {
      this.retry(
        definition,
        'worker-start-failed',
        'Temporal worker failed to start; retrying',
        err,
      );
      return;
    }
    if (this.stopping) return;
    this.workers.set(queue, worker);
    this.states.set(queue, 'running');
    this.failures.delete(queue);
    this.logger.info('worker-started', 'Temporal worker started', {
      'temporal.task_queue': queue,
    });
    const run: Promise<void> = worker
      .run()
      .then(
        () => {
          if (!this.stopping) {
            this.retry(
              definition,
              'worker-stopped',
              'Temporal worker stopped; restarting',
            );
          } else {
            this.states.set(queue, 'stopped');
          }
        },
        (err: unknown) => {
          if (this.stopping) {
            this.states.set(queue, 'stopped');
            return;
          }
          this.retry(
            definition,
            'worker-failed',
            'Temporal worker failed; restarting',
            err,
          );
        },
      )
      .finally(() => {
        this.runs.delete(run);
        if (this.workers.get(queue) === worker) this.workers.delete(queue);
      });
    this.runs.add(run);
  }

  private retry(
    definition: WorkflowWorkerDefinition,
    event: string,
    message: string,
    err?: unknown,
  ): void {
    if (this.stopping) return;
    const queue = definition.queue;
    const failures = (this.failures.get(queue) ?? 0) + 1;
    this.failures.set(queue, failures);
    this.states.set(queue, 'retrying');
    const delay = Math.min(
      WORKER_RETRY_MAX_MS,
      WORKER_RETRY_BASE_MS * 2 ** (failures - 1),
    );
    this.logger.warn(
      event,
      message,
      {
        'temporal.task_queue': queue,
        'messaging.retry.attempt': failures,
        'messaging.retry.delay_ms': delay,
      },
      err,
    );
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      void this.start(definition);
    }, delay);
    timer.unref?.();
    this.timers.add(timer);
  }
}
