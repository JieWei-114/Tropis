import {
  CircuitBreaker,
  CircuitBreakerOpenError,
} from '../../../../common/circuit-breaker/circuit-breaker';
import { AppError } from '../../../../common/errors';
import { createLogger } from '../../../../common/observability/logger';
import { probeCapability, type CapabilityHealth } from '../../../capability';
import type { PolicyInput, PolicyPort } from '../../policy.port';

const TIMEOUT_MS = 2000;

/**
 * PolicyPort over Open Policy Agent (`POST /v1/data/authz/allow`), with an
 * optional bearer token (OPA `--authentication=token`). A circuit breaker
 * stops calling OPA after repeated failures. An engine that cannot answer
 * is SERVICE_UNAVAILABLE, never a denial, so an outage is retried rather
 * than reported to the caller as missing permission.
 */
export class OpaPolicyAdapter implements PolicyPort {
  private readonly logger = createLogger('policy');
  private readonly breaker = new CircuitBreaker({
    name: 'OPA',
    failureThreshold: 5,
    resetTimeoutMs: 30_000,
  });

  constructor(
    private readonly opaUrl: string,
    private readonly token?: string,
  ) {}

  async allow(input: PolicyInput): Promise<boolean> {
    try {
      return await this.breaker.fire(async () => {
        const res = await this.request('/v1/data/authz/allow', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ input }),
        });
        if (!res.ok) {
          throw new Error(`OPA answered ${res.status}`);
        }
        const body = (await res.json()) as { result?: boolean };
        return body.result === true;
      });
    } catch (err) {
      if (err instanceof CircuitBreakerOpenError) {
        this.logger.warn('circuit-open', 'OPA circuit is open');
      } else {
        this.logger.warn('unreachable', 'OPA cannot answer', {}, err);
      }
      throw new AppError('SERVICE_UNAVAILABLE', {
        detail: 'Authorization cannot be decided right now',
        cause: err,
      });
    }
  }

  /** Readiness probe — OPA `/health` (does not evaluate policy). */
  health(): Promise<CapabilityHealth> {
    return probeCapability('opa', () => this.ping());
  }

  private async ping(): Promise<void> {
    const res = await this.request('/health', {});
    if (!res.ok) {
      throw new Error(`OPA health returned ${res.status}`);
    }
  }

  private async request(path: string, init: RequestInit): Promise<Response> {
    const headers = new Headers(init.headers);
    if (this.token) headers.set('Authorization', `Bearer ${this.token}`);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      return await fetch(`${this.opaUrl}${path}`, {
        ...init,
        headers,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }
  }
}
