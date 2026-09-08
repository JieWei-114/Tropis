import { Injectable, Inject } from '@nestjs/common';
import {
  HealthIndicator,
  HealthIndicatorResult,
  HealthCheckError,
} from '@nestjs/terminus';
import { AEROSPIKE_CLIENT } from '../../../infrastructure/aerospike/aerospike.module';

/**
 * Aerospike holds the login session records (SessionService).
 *
 * Every active datastore needs an indicator here: without one the Stack page
 * can only report it as "unknown", and a session-store outage is invisible to
 * the console and to any monitor scraping /api/health.
 *
 * The client is intentionally nullable: Aerospike is optional in the local
 * stack and SessionService degrades to a no-op without it. An absent client is
 * therefore reported as healthy-but-disabled rather than as a failure, since
 * nothing depends on it in that mode.
 */
@Injectable()
export class AerospikeHealthIndicator extends HealthIndicator {
  constructor(
    @Inject(AEROSPIKE_CLIENT) private readonly client: unknown | null,
  ) {
    super();
  }

  async isHealthy(key: string): Promise<HealthIndicatorResult> {
    if (!this.client) {
      return this.getStatus(key, true, { disabled: true });
    }
    try {
      const connected = (
        this.client as { isConnected?: () => boolean }
      ).isConnected?.();
      if (connected === false) throw new Error('client reports disconnected');
      return this.getStatus(key, true);
    } catch (err) {
      const result = this.getStatus(key, false, { message: String(err) });
      throw new HealthCheckError('Aerospike unreachable', result);
    }
  }
}
