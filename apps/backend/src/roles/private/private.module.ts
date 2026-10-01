import { Module } from '@nestjs/common';
import { RpcModule } from '../../infrastructure/rpc/rpc.module';
import { AuthModule } from '../../modules/auth/auth.module';
import { HealthRpcModule } from '../../modules/health/health-rpc.module';
import { UserInternalModule } from '../../modules/user/user-internal.module';
import { CoreModule } from '../shared/core.module';

/**
 * Private role: the internal-tier RPC listener only, reachable inside the
 * cluster. AuthModule provides the token verifier the RPC server needs.
 */
@Module({
  imports: [
    CoreModule,
    AuthModule,
    RpcModule.forRoot(),
    HealthRpcModule,
    UserInternalModule,
  ],
})
export class PrivateModule {}
