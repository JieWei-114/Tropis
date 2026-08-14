import { Injectable } from '@nestjs/common';
import {
  HealthIndicator,
  HealthIndicatorResult,
  HealthCheckError,
} from '@nestjs/terminus';
import { OpaService } from '../../../infrastructure/opa/opa.service';

@Injectable()
export class OpaHealthIndicator extends HealthIndicator {
  constructor(private readonly opa: OpaService) {
    super();
  }

  async isHealthy(key: string): Promise<HealthIndicatorResult> {
    try {
      await this.opa.ping();
      return this.getStatus(key, true);
    } catch (err) {
      const result = this.getStatus(key, false, { message: String(err) });
      throw new HealthCheckError('OPA unreachable', result);
    }
  }
}
