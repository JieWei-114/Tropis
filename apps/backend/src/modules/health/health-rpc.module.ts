import { Module } from '@nestjs/common';
import { HealthRpcController } from './controllers/health.rpc.controller';

/** tropis.health.v1.HealthService on whichever RPC listeners the role runs. */
@Module({
  providers: [HealthRpcController],
})
export class HealthRpcModule {}
