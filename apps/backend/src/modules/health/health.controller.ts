import { Controller, Get } from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import {
  HealthCheck,
  HealthCheckService,
  MongooseHealthIndicator,
} from '@nestjs/terminus';
import { SkipThrottle } from '@nestjs/throttler';
import { Public } from '../../common/decorators/public.decorator';
import { RedisHealthIndicator } from './indicators/redis.health';
import { PulsarHealthIndicator } from './indicators/pulsar.health';
import { ClickHouseHealthIndicator } from './indicators/clickhouse.health';
import { PostgresHealthIndicator } from './indicators/postgres.health';
import { ElasticsearchHealthIndicator } from './indicators/elasticsearch.health';
import { MinioHealthIndicator } from './indicators/minio.health';
import { TemporalHealthIndicator } from './indicators/temporal.health';
import { OpaHealthIndicator } from './indicators/opa.health';

@ApiTags('health')
@SkipThrottle()
@Controller('health')
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    private readonly mongo: MongooseHealthIndicator,
    private readonly redis: RedisHealthIndicator,
    private readonly pulsar: PulsarHealthIndicator,
    private readonly clickhouse: ClickHouseHealthIndicator,
    private readonly postgres: PostgresHealthIndicator,
    private readonly elasticsearch: ElasticsearchHealthIndicator,
    private readonly minio: MinioHealthIndicator,
    private readonly temporal: TemporalHealthIndicator,
    private readonly opa: OpaHealthIndicator,
  ) {}

  @Public()
  @Get()
  @HealthCheck()
  @ApiOperation({ summary: 'Check status of all infrastructure services' })
  check() {
    return this.health.check([
      () => this.mongo.pingCheck('mongo'),
      () => this.redis.isHealthy('redis'),
      () => this.clickhouse.isHealthy('clickhouse'),
      () => this.postgres.isHealthy('postgres'),
      () => this.elasticsearch.isHealthy('elasticsearch'),
      () => this.minio.isHealthy('minio'),
      () => this.opa.isHealthy('opa'),
      () => this.temporal.isHealthy('temporal'),
      // Pulsar probe can be slow if broker is starting — listed last
      () => this.pulsar.isHealthy('pulsar'),
    ]);
  }
}
