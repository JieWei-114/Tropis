import type { DescService } from '@bufbuild/protobuf';
import {
  Code,
  ConnectError,
  type ConnectRouter,
  type HandlerContext,
} from '@connectrpc/connect';
import {
  Health,
  HealthCheckResponse_ServingStatus as ServingStatus,
  type HealthCheckRequest,
} from '../../gen/grpc/health/v1/health_pb';

/**
 * The standard gRPC health service (grpc.health.v1.Health), which
 * grpc-health-probe, Kubernetes gRPC probes and load balancers speak.
 *
 * An empty `service` asks about the server as a whole; a named one must be a
 * service this listener serves, otherwise NOT_FOUND as the protocol
 * specifies. Once the listener starts draining every status turns
 * NOT_SERVING, so probes take the instance out of rotation before it stops.
 */
export class StandardHealth {
  private readonly served: Set<string>;
  private draining = false;
  private readonly watchers = new Set<() => void>();

  constructor(services: readonly DescService[]) {
    this.served = new Set([
      '',
      Health.typeName,
      ...services.map((s) => s.typeName),
    ]);
  }

  register(router: ConnectRouter): void {
    router.service(Health, {
      check: (req) => ({ status: this.statusOf(req) }),
      watch: (req, ctx) => this.watch(req, ctx),
    });
  }

  /** Flips every status to NOT_SERVING and tells open watch streams. */
  drain(): void {
    this.draining = true;
    for (const notify of this.watchers) notify();
  }

  private statusOf(req: HealthCheckRequest): ServingStatus {
    if (!this.served.has(req.service)) {
      throw new ConnectError(`Unknown service: ${req.service}`, Code.NotFound);
    }
    return this.draining ? ServingStatus.NOT_SERVING : ServingStatus.SERVING;
  }

  private async *watch(req: HealthCheckRequest, ctx: HandlerContext) {
    if (!this.served.has(req.service)) {
      yield { status: ServingStatus.SERVICE_UNKNOWN };
      return;
    }
    yield { status: this.statusOf(req) };
    if (this.draining) return;
    await new Promise<void>((resolve) => {
      const done = () => {
        this.watchers.delete(done);
        resolve();
      };
      this.watchers.add(done);
      ctx.signal.addEventListener('abort', done, { once: true });
    });
    if (!ctx.signal.aborted) yield { status: ServingStatus.NOT_SERVING };
  }
}
