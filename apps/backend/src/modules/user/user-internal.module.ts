import { Module } from '@nestjs/common';
import { UserModule } from './user.module';
import { UserInternalRpcController } from './controllers/user-internal.rpc.controller';

/** The internal-tier UserInternalService RPC, served by the private role. */
@Module({
  imports: [UserModule],
  providers: [UserInternalRpcController],
})
export class UserInternalModule {}
