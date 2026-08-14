import { Module, MiddlewareConsumer, NestModule } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { APP_GUARD } from '@nestjs/core';
import { ConfigModule } from '@nestjs/config';
import { DatabaseModule } from './infrastructure/database/database.module';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { ThrottlerModule } from '@nestjs/throttler';
import { ScheduleModule } from '@nestjs/schedule';
import { LoggerModule } from 'nestjs-pino';
import {
  appConfig,
  dbConfig,
  authConfig,
  messagingConfig,
} from './config/app.config';
import { envValidationSchema } from './config/env.validation';
import { RedisModule } from './infrastructure/redis/redis.module';
import { ClickhouseModule } from './infrastructure/clickhouse/clickhouse.module';
import { PulsarModule } from './infrastructure/pulsar/pulsar.module';
import { MessagingModule } from './infrastructure/messaging/messaging.module';
import { AerospikeModule } from './infrastructure/aerospike/aerospike.module';
import { AuthModule } from './modules/auth/auth.module';
import { HealthModule } from './modules/health/health.module';
import { GrpcModule } from './infrastructure/grpc/grpc.module';
import { QueueModule } from './infrastructure/queue/queue.module';
import { WebsocketModule } from './modules/websocket/websocket.module';
import { PostgresModule } from './infrastructure/postgres/postgres.module';
import { SearchModule } from './infrastructure/elasticsearch/search.module';
import { StorageModule } from './infrastructure/storage/storage.module';
import { NotificationModule } from './modules/notification/notification.module';
import { MetricsModule } from './modules/metrics/metrics.module';
import { VaultModule } from './infrastructure/vault/vault.module';
import { TemporalModule } from './infrastructure/temporal/temporal.module';
import { OpaModule } from './infrastructure/opa/opa.module';
import { OutboxModule } from './infrastructure/outbox/outbox.module';
import { FeatureFlagsModule } from './common/feature-flags/feature-flags.module';
import { TenantModule } from './common/tenant/tenant.module';
import { TenantMiddleware } from './common/tenant/tenant.middleware';
import { ThrottlerBehindProxyGuard } from './common/guards/throttler-behind-proxy.guard';
import { CorrelationIdMiddleware } from './common/middleware/correlation-id.middleware';
import { UserModule } from './modules/user/user.module';
import { AnalyticsModule } from './modules/analytics/analytics.module';
import { TrackingModule } from './modules/tracking/tracking.module';
import { AuditModule } from './modules/audit/audit.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: '.env',
      load: [appConfig, dbConfig, authConfig, messagingConfig],
      validationSchema: envValidationSchema,
      validationOptions: {
        allowUnknown: true,
        abortEarly: false,
      },
    }),

    LoggerModule.forRoot({
      pinoHttp: {
        transport:
          process.env.NODE_ENV !== 'production'
            ? { target: 'pino-pretty', options: { singleLine: true } }
            : undefined,
        level: process.env.LOG_LEVEL ?? 'info',
        redact: ['req.headers.authorization'],
        genReqId: (req) =>
          (req.headers['x-request-id'] as string | undefined) ?? randomUUID(),
      },
    }),

    DatabaseModule,

    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 100 }]),
    ScheduleModule.forRoot(),
    EventEmitterModule.forRoot({
      wildcard: false,
      delimiter: '.',
      maxListeners: 20,
    }),

    // Secret management — must be first so secrets are in process.env before other modules read them
    VaultModule,

    // Infrastructure
    RedisModule,
    ClickhouseModule,
    PulsarModule,
    MessagingModule,
    AerospikeModule,
    PostgresModule,
    SearchModule,
    StorageModule,
    NotificationModule,
    MetricsModule,

    // Authorization
    OpaModule,

    // Multi-tenancy
    TenantModule,

    // Reliability
    OutboxModule,
    FeatureFlagsModule,

    // Workflow orchestration
    TemporalModule,

    // Transport
    QueueModule,
    WebsocketModule,
    GrpcModule,

    // Feature modules
    AuthModule,
    HealthModule,
    UserModule,
    AnalyticsModule,
    TrackingModule,
    AuditModule,
  ],
  providers: [
    // Global rate limiting — proxy-aware (reads X-Forwarded-For via req.ips)
    {
      provide: APP_GUARD,
      useClass: ThrottlerBehindProxyGuard,
    },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer
      .apply(CorrelationIdMiddleware, TenantMiddleware)
      .forRoutes('*path');
  }
}
