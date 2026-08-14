import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { UserRole } from '../../modules/user/schemas/user.schema';
import {
  CircuitBreaker,
  CircuitBreakerOpenError,
} from '../../common/circuit-breaker/circuit-breaker';

export interface OpaInput {
  roles: UserRole[];
  resource: string;
  action: string;
}

@Injectable()
export class OpaService {
  private readonly logger = new Logger(OpaService.name);
  private readonly opaUrl: string;
  private readonly breaker = new CircuitBreaker({
    name: 'OPA',
    failureThreshold: 5,
    resetTimeoutMs: 30_000,
  });

  constructor(config: ConfigService) {
    this.opaUrl = config.get<string>('OPA_URL', 'http://localhost:8181');
  }

  async allow(input: OpaInput): Promise<boolean> {
    try {
      return await this.breaker.fire(async () => {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 2000);

        try {
          const res = await fetch(`${this.opaUrl}/v1/data/authz/allow`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ input }),
            signal: controller.signal,
          });

          if (!res.ok) {
            this.logger.warn(`OPA returned ${res.status} — denying by default`);
            return false;
          }

          const body = (await res.json()) as { result?: boolean };
          return body.result === true;
        } finally {
          clearTimeout(timeout);
        }
      });
    } catch (err) {
      if (err instanceof CircuitBreakerOpenError) {
        this.logger.warn(err.message);
      } else {
        this.logger.warn(
          `OPA unreachable (${(err as Error).message}) — denying by default`,
        );
      }
      return false;
    }
  }

  /** Readiness probe — OPA `/health` (does not evaluate policy). */
  async ping(): Promise<void> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2000);
    try {
      const res = await fetch(`${this.opaUrl}/health`, {
        signal: controller.signal,
      });
      if (!res.ok) {
        throw new Error(`OPA health returned ${res.status}`);
      }
    } finally {
      clearTimeout(timeout);
    }
  }
}
