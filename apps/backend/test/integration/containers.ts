import { execFileSync } from 'child_process';
import { randomUUID } from 'crypto';
import Redis from 'ioredis';
import { createServer } from 'net';

/**
 * Minimal docker-CLI container runner for images the testcontainers modules
 * installed here do not cover (Kafka, Pulsar, Neo4j, Aerospike). Every
 * container gets a unique name, is started with --rm, and is force-removed
 * on stop() and again on process exit, so an aborted run leaves nothing
 * behind.
 */

export interface ContainerSpec {
  image: string;
  /** Short label used in the container name. */
  label: string;
  /** Container ports published on a random 127.0.0.1 port. */
  ports?: number[];
  /** Container port → fixed host port (for brokers that advertise their address). */
  fixedPorts?: Record<number, number>;
  env?: Record<string, string>;
  /** Host path → container path, mounted read-only. */
  volumes?: Record<string, string>;
  command?: string[];
}

export interface StartedContainer {
  readonly name: string;
  readonly host: string;
  /** Host port mapped to `containerPort`. */
  port(containerPort: number): number;
  logs(): string;
  stop(): Promise<void>;
}

const running = new Set<string>();

process.once('exit', () => {
  for (const name of running) {
    try {
      execFileSync('docker', ['rm', '-f', name], { stdio: 'ignore' });
    } catch {
      // Already gone.
    }
  }
});

function docker(args: string[]): string {
  return execFileSync('docker', args, { encoding: 'utf8' }).trim();
}

export function startContainer(spec: ContainerSpec): StartedContainer {
  const name = `tropis-conformance-${spec.label}-${randomUUID().slice(0, 8)}`;
  const args = ['run', '-d', '--rm', '--name', name];
  for (const port of spec.ports ?? []) args.push('-p', `127.0.0.1::${port}`);
  for (const [containerPort, hostPort] of Object.entries(
    spec.fixedPorts ?? {},
  )) {
    args.push('-p', `127.0.0.1:${hostPort}:${containerPort}`);
  }
  for (const [key, value] of Object.entries(spec.env ?? {})) {
    args.push('-e', `${key}=${value}`);
  }
  for (const [hostPath, containerPath] of Object.entries(spec.volumes ?? {})) {
    args.push('-v', `${hostPath}:${containerPath}:ro`);
  }
  args.push(spec.image, ...(spec.command ?? []));

  docker(args);
  running.add(name);

  const mapped = new Map<number, number>();
  for (const [containerPort, hostPort] of Object.entries(
    spec.fixedPorts ?? {},
  )) {
    mapped.set(Number(containerPort), hostPort);
  }
  for (const port of spec.ports ?? []) {
    const binding = docker(['port', name, `${port}/tcp`]).split('\n')[0];
    mapped.set(port, Number(binding.slice(binding.lastIndexOf(':') + 1)));
  }

  return {
    name,
    host: '127.0.0.1',
    port(containerPort: number): number {
      const port = mapped.get(containerPort);
      if (port === undefined)
        throw new Error(`Port ${containerPort} not published`);
      return port;
    },
    logs(): string {
      try {
        return execFileSync('docker', ['logs', '--tail', '50', name], {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch {
        return '';
      }
    },
    stop(): Promise<void> {
      try {
        execFileSync('docker', ['rm', '-f', name], { stdio: 'ignore' });
      } finally {
        running.delete(name);
      }
      return Promise.resolve();
    },
  };
}

/** A currently free TCP port on 127.0.0.1. */
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

/** Polls `probe` until it resolves truthy or `timeoutMs` elapses. */
export async function waitUntil(
  what: string,
  probe: () => Promise<unknown>,
  timeoutMs: number,
  container?: StartedContainer,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      if (await probe()) return;
    } catch (err) {
      lastError = err;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(
    `Timed out waiting for ${what}: ${String(lastError)}\n${container?.logs() ?? ''}`,
  );
}

/** Starts redis:7-alpine and waits until it answers PING. */
export async function startRedis(): Promise<StartedContainer> {
  const container = startContainer({
    image: 'redis:7-alpine',
    label: 'redis',
    ports: [6379],
  });
  await readyOrStop(container, () =>
    waitUntil(
      'redis',
      async () => {
        const probe = new Redis({
          host: container.host,
          port: container.port(6379),
          lazyConnect: true,
          maxRetriesPerRequest: 0,
          retryStrategy: () => null,
        });
        try {
          await probe.connect();
          return (await probe.ping()) === 'PONG';
        } finally {
          probe.disconnect();
        }
      },
      60_000,
      container,
    ),
  );
  return container;
}

/** Runs the readiness wait and removes the container if it never gets ready. */
export async function readyOrStop(
  container: StartedContainer,
  ready: () => Promise<void>,
): Promise<void> {
  try {
    await ready();
  } catch (err) {
    await container.stop();
    throw err;
  }
}
