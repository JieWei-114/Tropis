import { Module } from '@nestjs/common';
import { RpcModule } from '../../infrastructure/rpc/rpc.module';
import { AnalyticsModule } from './analytics.module';
import { AnalyticsRpcController } from './controllers/analytics.rpc.controller';

/** The public AnalyticsService RPC. */
@Module({
  imports: [AnalyticsModule, RpcModule.forRoot()],
  providers: [AnalyticsRpcController],
})
export class AnalyticsApiModule {}
