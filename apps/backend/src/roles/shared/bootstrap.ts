import { NestFactory } from '@nestjs/core';
import type { INestApplicationContext, Type } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Logger } from 'nestjs-pino';
import { EventEmitter } from 'events';
import { createLogger } from '../../common/observability/logger';
import { serviceInfo } from '../../common/observability/service-info';
import { OpsServer } from '../../modules/health/ops-server';
import { HealthProbesService } from '../../modules/health/services/health-probes.service';

/** Stops a surface accepting new work and waits for its in-flight calls. */
export type StopAccepting = () => Promise<void>;

/**
 * Opens one inbound surface and records what it listens on. Returns how to
 * stop it accepting, which shutdown runs before any module is torn down.
 */
export type Surface = (
  app: INestApplicationContext,
  listening: Record<string, unknown>,
) => Promise<StopAccepting | void>;

export interface RoleBoot {
  /** Creates the Nest app; a plain application context unless the role serves HTTP. */
  create?: (root: Type<unknown>) => Promise<INestApplicationContext>;
  surfaces?: readonly Surface[];
}

/** Grace period so the log is flushed before the process exits. */
const UNCAUGHT_EXIT_DELAY_MS = 100;

/** Longest wait for in-flight calls before teardown proceeds anyway. */
export const DRAIN_TIMEOUT_MS = 10_000;

/**
 * Longest a whole shutdown may take before the process exits regardless:
 * within the pod's termination grace period (30 s, the worker's 60 s), so a
 * close that never settles (a broker client, a stuck job) ends in a clean
 * exit code instead of a SIGKILL. SHUTDOWN_TIMEOUT_MS overrides it.
 */
export function shutdownDeadlineMs(
  role: string,
  env: NodeJS.ProcessEnv = process.env,
): number {
  const configured = Number(env.SHUTDOWN_TIMEOUT_MS);
  if (Number.isInteger(configured) && configured > 0) return configured;
  return role === 'worker' ? 55_000 : 20_000;
}

/** OPS_PORT before config is validated; the schema default otherwise. */
export function opsPortFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  const port = Number(env.OPS_PORT);
  return Number.isInteger(port) && port >= 0 ? port : 9464;
}

export interface ShutdownOptions {
  drainTimeoutMs?: number;
  /** The ops listener; the app's OpsServer provider when omitted. */
  ops?: OpsServer;
}

const logger = createLogger('bootstrap');

/**
 * Without these, a single unhandled rejection anywhere (e.g. a fire-and-forget
 * DB write during a database blip) terminates the process on Node >= 15. An
 * uncaught exception leaves torn-down state, so it logs and exits and the
 * orchestrator restarts a clean process.
 */
function installProcessGuards(): void {
  process.on('unhandledRejection', (reason) => {
    const err = reason instanceof Error ? reason : new Error(String(reason));
    logger.error('unhandled-rejection', 'Unhandled promise rejection', err);
  });
  process.on('uncaughtException', (err: Error) => {
    logger.error('uncaught-exception', 'Uncaught exception', err);
    setTimeout(() => process.exit(1), UNCAUGHT_EXIT_DELAY_MS).unref();
  });
}

/**
 * Shuts a role down in dependency order:
 *   1. the ops port reports not ready and every surface stops accepting
 *      (RPC listeners, the HTTP server) and drains its in-flight calls, up to
 *      DRAIN_TIMEOUT_MS;
 *   2. app.close(): onModuleDestroy stops consumers, job workers and the
 *      relay, which finish their in-flight work;
 *   3. onApplicationShutdown releases each connection (Mongo, Redis, Pulsar)
 *      and closes the ops port.
 */
export async function shutdownRole(
  app: INestApplicationContext,
  stops: readonly StopAccepting[],
  options: ShutdownOptions | number = {},
): Promise<void> {
  const { drainTimeoutMs = DRAIN_TIMEOUT_MS, ops } =
    typeof options === 'number' ? { drainTimeoutMs: options } : options;
  const listener: OpsServer = ops ?? app.get(OpsServer);
  listener.drain();
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, drainTimeoutMs);
  });
  const drained = Promise.all(
    stops.map((stop) =>
      stop().catch((err: unknown) =>
        logger.warn('drain-failed', 'Surface did not drain cleanly', {}, err),
      ),
    ),
  );
  await Promise.race([drained, timeout]);
  clearTimeout(timer);
  await app.close();
  if (ops) await ops.onApplicationShutdown();
}

function installShutdown(
  app: INestApplicationContext,
  stops: readonly StopAccepting[],
  ops: OpsServer,
): void {
  let started = false;
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.once(signal, () => {
      if (started) return;
      started = true;
      logger.info('shutdown', 'Shutting down', { signal });
      const deadline = shutdownDeadlineMs(serviceInfo().role);
      setTimeout(() => {
        logger.error(
          'shutdown-deadline',
          'Shutdown did not finish in time; exiting',
          undefined,
          { 'process.shutdown.deadline_ms': deadline },
        );
        process.exit(1);
      }, deadline).unref();
      shutdownRole(app, stops, { ops })
        .then(() => process.exit(0))
        .catch((err: unknown) => {
          logger.error('shutdown-failed', 'Shutdown failed', err);
          process.exit(1);
        });
    });
  }
}

/**
 * Boots one role. The ops port opens first, so liveness answers while the
 * modules connect and /readyz reports `starting` (503) until the root
 * module, its surfaces and every bootstrap hook are done. SIGTERM/SIGINT run
 * shutdownRole, bounded by shutdownDeadlineMs.
 */
const DEFAULT_BOOT_TIMEOUT_MS = 150_000;

function bootTimeoutMs(): number {
  const value = Number(process.env.BOOT_TIMEOUT_MS);
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_BOOT_TIMEOUT_MS;
}

export async function bootstrapRole(
  root: Type<unknown>,
  boot: RoleBoot = {},
): Promise<void> {
  installProcessGuards();
  try {
    EventEmitter.defaultMaxListeners = 20;
    const ops = new OpsServer();
    const opsPort = await ops.listen(opsPortFromEnv());
    // /livez answers as soon as the ops port opens, so a boot that hangs is
    // ended here and the orchestrator restarts the process.
    const bootDeadline = setTimeout(() => {
      logger.error('boot-timeout', 'Backend did not finish booting in time');
      process.exit(1);
    }, bootTimeoutMs());
    bootDeadline.unref();

    const app = boot.create
      ? await boot.create(root)
      : await NestFactory.createApplicationContext(root, { bufferLogs: true });
    app.useLogger(app.get(Logger));

    const stops: StopAccepting[] = [];
    installShutdown(app, stops, ops);

    const listening: Record<string, unknown> = { role: serviceInfo().role };
    for (const surface of boot.surfaces ?? []) {
      const stop = await surface(app, listening);
      if (stop) stops.push(stop);
    }

    const configured = app.get(ConfigService).get<number>('OPS_PORT');
    if (configured !== undefined && Number(configured) !== opsPort) {
      logger.warn(
        'ops-port-mismatch',
        'OPS_PORT from secrets differs from the port the ops listener opened before config loaded',
        { 'server.port': opsPort },
      );
    }
    listening.opsPort = opsPort;
    ops.attach(app.get(HealthProbesService));
    clearTimeout(bootDeadline);

    logger.info('listening', 'Backend listening', listening);
  } catch (err) {
    logger.error('failed', 'Backend failed to start', err);
    process.exit(1);
  }
}
