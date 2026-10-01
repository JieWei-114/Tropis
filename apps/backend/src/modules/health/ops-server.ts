import {
  Injectable,
  Optional,
  type BeforeApplicationShutdown,
  type OnApplicationShutdown,
} from '@nestjs/common';
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'http';
import type { AddressInfo } from 'net';
import { register } from 'prom-client';
import { createLogger } from '../../common/observability/logger';
import { serviceInfo } from '../../common/observability/service-info';
import { requiredProbes } from './health.probes';
import {
  HealthProbesService,
  withoutMessages,
} from './services/health-probes.service';

const logger = createLogger('health');

/**
 * The ops listener every role runs on OPS_PORT, apart from any public port:
 *
 * - /livez   the process is up and its event loop answers; no dependency
 *            checks, so an outage never makes the orchestrator restart it;
 * - /readyz  503 until boot has finished (`starting`), while a dependency
 *            this role requires (READINESS_PROBES) is down, and from the
 *            moment shutdown begins; optional ones that are down are listed
 *            in `degraded` but keep it 200. Probe messages are left out;
 * - /metrics the Prometheus registry.
 *
 * Each role opens it before anything else boots (bootstrap.ts), with no
 * probes attached, so liveness answers while modules connect; attach()
 * hands it the probes once boot is done. Constructed by Nest it starts
 * attached. Nothing routes this port from outside the cluster.
 */
@Injectable()
export class OpsServer
  implements BeforeApplicationShutdown, OnApplicationShutdown
{
  private server: Server | null = null;
  private draining = false;
  private probes: HealthProbesService | null;

  constructor(@Optional() probes?: HealthProbesService) {
    this.probes = probes ?? null;
  }

  /** Boot has finished: /readyz reports the probes from now on. */
  attach(probes: HealthProbesService): void {
    this.probes = probes;
  }

  async listen(port: number, host = '0.0.0.0'): Promise<number> {
    const server = createServer((req, res) => {
      this.handle(req, res).catch((err: unknown) => {
        logger.error('ops-request-failed', 'Ops request failed', err, {
          'url.path': (req.url ?? '/').split('?')[0],
        });
        if (!res.headersSent) send(res, 500, { status: 'error' });
        else res.destroy();
      });
    });
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, () => resolve());
    });
    return (server.address() as AddressInfo).port;
  }

  /** Reports not ready from now on; the first step of shutdown. */
  drain(): void {
    this.draining = true;
  }

  beforeApplicationShutdown(): void {
    this.drain();
  }

  async onApplicationShutdown(): Promise<void> {
    const server = this.server;
    this.server = null;
    if (!server) return;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  private async handle(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const path = (req.url ?? '/').split('?')[0];
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return send(res, 405, { status: 'error' });
    }
    switch (path) {
      case '/livez':
        return send(res, 200, { status: 'ok' });
      case '/readyz':
        return this.ready(res);
      case '/metrics': {
        const body = await register.metrics();
        res.writeHead(200, { 'content-type': register.contentType });
        res.end(body);
        return;
      }
      default:
        return send(res, 404, { status: 'error' });
    }
  }

  private async ready(res: ServerResponse): Promise<void> {
    if (this.draining) return send(res, 503, { status: 'shutting_down' });
    if (!this.probes) return send(res, 503, { status: 'starting' });
    try {
      const report = await this.probes.report(
        requiredProbes(serviceInfo().role),
        'readiness',
      );
      send(res, report.status === 'ok' ? 200 : 503, withoutMessages(report));
    } catch {
      send(res, 503, { status: 'error' });
    }
  }
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}
