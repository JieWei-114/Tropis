import { Module } from '@nestjs/common';
import { MulterModule } from '@nestjs/platform-express';
import { ObjectsModule } from '../../infrastructure/objects/objects.module';
import { RpcModule } from '../../infrastructure/rpc/rpc.module';
import { OnboardingController } from './controllers/onboarding.controller';
import { UserController } from './controllers/user.controller';
import { UserRpcController } from './controllers/user.rpc.controller';
import { UserAvatarService } from './services/user-avatar.service';
import { UserModule } from './user.module';
import { UserOnboardingModule } from './user-onboarding.module';
import { UserSearchModule } from './user-search.module';

/** REST /api/users/*, /api/workflows/onboarding and the public UserService RPC. */
@Module({
  imports: [
    UserModule,
    UserSearchModule,
    UserOnboardingModule,
    ObjectsModule.forRoot(),
    RpcModule.forRoot(),
    // Memory storage: the buffer is passed to the objects port.
    MulterModule.register({ storage: undefined }),
  ],
  controllers: [UserController, OnboardingController],
  providers: [UserRpcController, UserAvatarService],
})
export class UserApiModule {}
