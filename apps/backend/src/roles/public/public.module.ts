import { Module, MiddlewareConsumer, NestModule } from '@nestjs/common';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { ThrottlerModule } from '@nestjs/throttler';
import { ThrottlerBehindProxyGuard } from '../../common/guards/throttler-behind-proxy.guard';
import { RateLimitThrottlerStorage } from '../../common/guards/ratelimit-throttler.storage';
import {
  RATE_LIMIT,
  type RateLimitPort,
} from '../../infrastructure/ratelimit/ratelimit.port';
import { AuditInterceptor } from '../../common/audit/audit.interceptor';
import { AuditModule } from '../../common/audit/audit.module';
import { AuthorizeGuard } from '../../common/authz/authorize.guard';
import { AuthzModule } from '../../common/authz/authz.module';
import { CorrelationIdMiddleware } from '../../common/middleware/correlation-id.middleware';
import { HttpTenantInterceptor } from '../../common/interceptors/http-tenant.interceptor';
import { TenantMiddleware } from '../../common/tenant/tenant.middleware';
import { AnalyticsApiModule } from '../../features/analytics/analytics-api.module';
import { TrackingApiModule } from '../../features/tracking/tracking-api.module';
import { JobsDashboardModule } from '../../infrastructure/jobs/jobs-dashboard.module';
import { RateLimitModule } from '../../infrastructure/ratelimit/ratelimit.module';
import { RpcModule } from '../../infrastructure/rpc/rpc.module';
import { AuthApiModule } from '../../modules/auth/auth-api.module';
import { JwtAuthGuard } from '../../modules/auth/guards/jwt-auth.guard';
import { HealthApiModule } from '../../modules/health/health-api.module';
import { HealthRpcModule } from '../../modules/health/health-rpc.module';
import { UserApiModule } from '../../modules/user/user-api.module';
import { WebsocketModule } from '../../modules/websocket/websocket.module';
import { CoreModule } from '../shared/core.module';

/**
 * Public role: the HTTP API (REST exceptions), the public RPC listener and
 * the WebSocket gateway. No consumers, workers or schedules.
 */
@Module({
  imports: [
    CoreModule,

    // Named throttlers, resolved through ConfigService so the limits are
    // environment-tunable. The decorators reference a NAME only: a decorator
    // runs at class-definition time, so putting process.env reads in
    // @Throttle() would silently bypass the validated config.
    ThrottlerModule.forRootAsync({
      imports: [RateLimitModule.forRoot()],
      inject: [ConfigService, RATE_LIMIT],
      useFactory: (config: ConfigService, rateLimit: RateLimitPort) => ({
        // Counted in the shared ratelimit store, so limits hold across replicas.
        storage: new RateLimitThrottlerStorage(rateLimit),
        throttlers: [
          {
            name: 'default',
            ttl: config.getOrThrow<number>('RATE_LIMIT_TTL_MS'),
            limit: config.getOrThrow<number>('RATE_LIMIT_DEFAULT'),
          },
          {
            // Credential endpoints are deliberately much tighter than the
            // global limit; raise it only for load tests and browser E2E,
            // which drive many real sign-ins from one IP.
            name: 'auth',
            ttl: config.getOrThrow<number>('RATE_LIMIT_TTL_MS'),
            limit: config.getOrThrow<number>('RATE_LIMIT_AUTH'),
            // Applies only to the routes that select it with
            // @Throttle({ auth: {} }) (ThrottlerBehindProxyGuard).
          },
          {
            // Refresh runs on every page load and token expiry, so it gets
            // its own looser limit instead of the credential one.
            name: 'refresh',
            ttl: config.getOrThrow<number>('RATE_LIMIT_TTL_MS'),
            limit: config.getOrThrow<number>('RATE_LIMIT_REFRESH'),
          },
        ],
      }),
    }),

    RpcModule.forRoot(),
    AuthzModule,
    AuditModule,
    HealthRpcModule,
    WebsocketModule,
    JobsDashboardModule,

    AuthApiModule,
    HealthApiModule,
    UserApiModule,

    AnalyticsApiModule,
    TrackingApiModule,
  ],
  providers: [
    // Global rate limiting — proxy-aware (reads X-Forwarded-For via req.ips)
    { provide: APP_GUARD, useClass: ThrottlerBehindProxyGuard },
    // HTTP routes are authenticated by default; @Public() is the explicit
    // opt-out, so a new controller is never published by accident.
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    // @Authorize on HTTP routes, after the JWT guard set req.user.
    { provide: APP_GUARD, useExisting: AuthorizeGuard },
    // Audit entries for @Audited routes.
    { provide: APP_INTERCEPTOR, useExisting: AuditInterceptor },
    // Binds TenantContext around every HTTP handler; RPC calls are bound by
    // the RpcServer's own tenant interceptor.
    { provide: APP_INTERCEPTOR, useClass: HttpTenantInterceptor },
  ],
})
export class PublicModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer
      .apply(CorrelationIdMiddleware, TenantMiddleware)
      .forRoutes('*path');
  }
}
