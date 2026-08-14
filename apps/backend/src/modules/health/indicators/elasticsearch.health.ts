import { Injectable } from '@nestjs/common';
import {
  HealthIndicator,
  HealthIndicatorResult,
  HealthCheckError,
} from '@nestjs/terminus';
import { SearchService } from '../../../infrastructure/elasticsearch/search.service';

@Injectable()
export class ElasticsearchHealthIndicator extends HealthIndicator {
  constructor(private readonly search: SearchService) {
    super();
  }

  async isHealthy(key: string): Promise<HealthIndicatorResult> {
    try {
      // Re-uses the SearchService which already has a connected ES client
      // A cheap ping: attempt to get cluster info
      await (this.search as any).es.ping();
      return this.getStatus(key, true);
    } catch (err) {
      const result = this.getStatus(key, false, { message: String(err) });
      throw new HealthCheckError('Elasticsearch unreachable', result);
    }
  }
}
