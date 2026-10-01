import { Module } from '@nestjs/common';
import { OpsServer } from './ops-server';
import { HealthProbesService } from './services/health-probes.service';

/** Dependency probes and the ops listener (OPS_PORT); in every role. */
@Module({
  providers: [HealthProbesService, OpsServer],
  exports: [HealthProbesService, OpsServer],
})
export class HealthModule {}
