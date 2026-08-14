import { Injectable } from '@nestjs/common';
import {
  HealthIndicator,
  HealthIndicatorResult,
  HealthCheckError,
} from '@nestjs/terminus';
import { TemporalService } from '../../../infrastructure/temporal/temporal.service';

@Injectable()
export class TemporalHealthIndicator extends HealthIndicator {
  constructor(private readonly temporal: TemporalService) {
    super();
  }

  async isHealthy(key: string): Promise<HealthIndicatorResult> {
    try {
      await this.temporal.ping();
      return this.getStatus(key, true);
    } catch (err) {
      const result = this.getStatus(key, false, { message: String(err) });
      throw new HealthCheckError('Temporal unreachable', result);
    }
  }
}
