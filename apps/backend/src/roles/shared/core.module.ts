import { Module } from '@nestjs/common';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { ObservabilityModule } from '../../common/observability/observability.module';
import { MetricsModule } from '../../common/observability/metrics.module';
import { TenantModule } from '../../common/tenant/tenant.module';
import { HealthModule } from '../../modules/health/health.module';
import { validatedConfigModule } from './validated-config';

/**
 * What every role runs, and nothing that depends on a datastore: validated
 * config (Vault secrets merged first), logging/tracing/errors, the tenant
 * context, the in-process event bus, the metrics registry and the ops
 * listener (health + metrics on OPS_PORT). Capabilities are imported by the
 * modules that use them, so a role connects only to what its modules need.
 */
@Module({
  imports: [
    validatedConfigModule(),
    ObservabilityModule.forRoot(),
    EventEmitterModule.forRoot({
      wildcard: false,
      delimiter: '.',
      maxListeners: 20,
    }),
    MetricsModule,
    TenantModule,
    HealthModule,
  ],
})
export class CoreModule {}
