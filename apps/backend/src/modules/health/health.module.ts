import { Module } from '@nestjs/common';
import { TerminusModule } from '@nestjs/terminus';
import { TypeOrmModule } from '@nestjs/typeorm';
import { HealthController } from './health.controller';
import { RedisHealthIndicator } from './indicators/redis.health';
import { PulsarHealthIndicator } from './indicators/pulsar.health';
import { ClickHouseHealthIndicator } from './indicators/clickhouse.health';
import { PostgresHealthIndicator } from './indicators/postgres.health';
import { ElasticsearchHealthIndicator } from './indicators/elasticsearch.health';
import { MinioHealthIndicator } from './indicators/minio.health';
import { TemporalHealthIndicator } from './indicators/temporal.health';
import { OpaHealthIndicator } from './indicators/opa.health';
import { AerospikeHealthIndicator } from './indicators/aerospike.health';

@Module({
  imports: [TerminusModule, TypeOrmModule],
  controllers: [HealthController],
  providers: [
    RedisHealthIndicator,
    PulsarHealthIndicator,
    ClickHouseHealthIndicator,
    PostgresHealthIndicator,
    ElasticsearchHealthIndicator,
    MinioHealthIndicator,
    TemporalHealthIndicator,
    OpaHealthIndicator,
    AerospikeHealthIndicator,
  ],
})
export class HealthModule {}
