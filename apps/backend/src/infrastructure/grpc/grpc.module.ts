import { Module, forwardRef } from '@nestjs/common';
import { APP_FILTER, APP_INTERCEPTOR } from '@nestjs/core';
import { UserModule } from '../../modules/user/user.module';
import { AnalyticsModule } from '../../modules/analytics/analytics.module';
import { TenantModule } from '../../common/tenant/tenant.module';
import { GrpcHealthService } from './grpc-health.service';
import { GrpcUserService } from '../../modules/user/controllers/user.grpc.controller';
import { GrpcUserInternalService } from '../../modules/user/controllers/user-internal.grpc.controller';
import { GrpcAuthService } from '../../modules/auth/controllers/auth.grpc.controller';
import { GrpcAnalyticsService } from '../../modules/analytics/controllers/analytics.grpc.controller';
import { GrpcTrackingService } from '../../modules/tracking/controllers/tracking.grpc.controller';
import { TrackingModule } from '../../modules/tracking/tracking.module';
import { GrpcTenantInterceptor } from './grpc-tenant.interceptor';
import { GrpcAuthzService } from './grpc-authz.service';
import { GrpcErrorInterceptor } from './grpc-error.interceptor';
import { GrpcExceptionFilter } from '../../common/filters/grpc-exception.filter';

@Module({
  imports: [
    forwardRef(() => UserModule),
    forwardRef(() => AnalyticsModule),
    forwardRef(() => TrackingModule),
    TenantModule,
  ],
  controllers: [
    GrpcHealthService,
    GrpcAuthService,
    GrpcUserService,
    GrpcUserInternalService, // internal tier — docs/api-conventions.md
    GrpcAnalyticsService,
    GrpcTrackingService,
  ],
  providers: [
    GrpcAuthzService,
    { provide: APP_FILTER, useClass: GrpcExceptionFilter },
    { provide: APP_INTERCEPTOR, useClass: GrpcTenantInterceptor },
    // Only acts on rpc contexts. Registered as a module-level APP_INTERCEPTOR
    // (like GrpcTenantInterceptor above) rather than on the microservice
    // instance: enhancers attached to a connectMicroservice() instance are not
    // applied to handlers whose module lives in the host app.
    { provide: APP_INTERCEPTOR, useClass: GrpcErrorInterceptor },
  ],
})
export class GrpcModule {}
