import {
  HealthCheckError,
  HealthIndicator,
  HealthIndicatorResult,
} from '@nestjs/terminus';
import type { HealthCheckable } from './capability-status';

/**
 * Base terminus indicator for a capability port. `disabled` reports healthy
 * with `disabled: true` (the same convention as the Aerospike indicator):
 * nothing depends on a capability that is switched off, so it must not fail
 * the aggregate health check.
 */
export abstract class CapabilityHealthIndicator extends HealthIndicator {
  protected constructor(
    private readonly capability: string,
    private readonly target: HealthCheckable,
  ) {
    super();
  }

  async isHealthy(
    key: string = this.capability,
  ): Promise<HealthIndicatorResult> {
    const health = await this.target.health();
    switch (health.status) {
      case 'up':
        return this.getStatus(key, true, { adapter: health.adapter });
      case 'disabled':
        return this.getStatus(key, true, {
          adapter: health.adapter,
          disabled: true,
        });
      default: {
        const result = this.getStatus(key, false, {
          adapter: health.adapter,
          message: health.message,
        });
        throw new HealthCheckError(`${this.capability} unavailable`, result);
      }
    }
  }
}
