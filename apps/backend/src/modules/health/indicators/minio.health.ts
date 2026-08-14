import { Injectable } from '@nestjs/common';
import {
  HealthIndicator,
  HealthIndicatorResult,
  HealthCheckError,
} from '@nestjs/terminus';
import { StorageService } from '../../../infrastructure/storage/storage.service';

@Injectable()
export class MinioHealthIndicator extends HealthIndicator {
  constructor(private readonly storage: StorageService) {
    super();
  }

  async isHealthy(key: string): Promise<HealthIndicatorResult> {
    try {
      await this.storage.ping();
      return this.getStatus(key, true);
    } catch (err) {
      const result = this.getStatus(key, false, { message: String(err) });
      throw new HealthCheckError('MinIO unreachable', result);
    }
  }
}
