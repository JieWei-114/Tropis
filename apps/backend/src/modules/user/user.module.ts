import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { CqrsModule } from '@nestjs/cqrs';
import { CacheModule } from '../../infrastructure/cache/cache.module';
import { DedupModule } from '../../infrastructure/dedup/dedup.module';
import { DocumentsModule } from '../../infrastructure/documents/documents.module';
import { KvModule } from '../../infrastructure/kv/kv.module';
import { OutboxModule } from '../../infrastructure/outbox/outbox.module';
import { RateLimitModule } from '../../infrastructure/ratelimit/ratelimit.module';
import { RealtimeModule } from '../../infrastructure/realtime/realtime.module';
import { TenantDirectoryModule } from '../tenant/tenant-directory.module';
import { User, UserSchema } from './schemas/user.schema';
import { UserService } from './services/user.service';
import { UserRepository } from './repositories/user.repository';
import { UserEventHandlers } from './events/user-event.handlers';
import { SignupPolicyService } from './services/signup-policy.service';
import { CreateUserHandler } from './commands/create-user.command';
import { UpdateUserHandler } from './commands/update-user.command';
import { DeleteUserHandler } from './commands/delete-user.command';
import { UpdateRolesHandler } from './commands/update-roles.command';
import { GetUserHandler } from './queries/get-user.query';
import { ListUsersHandler } from './queries/list-users.query';
import { UserEventStoreService } from './event-store/user-event-store.service';
import {
  UserEvent,
  UserEventSchema,
} from './event-store/user-event-store.schema';

const CommandHandlers = [
  CreateUserHandler,
  UpdateUserHandler,
  DeleteUserHandler,
  UpdateRolesHandler,
];
const QueryHandlers = [GetUserHandler, ListUsersHandler];

/**
 * Users without any transport: services, CQRS handlers and storage. The
 * endpoints are UserApiModule (public) and UserInternalModule (private); the
 * event consumer is UserWorkerModule; search and similarity are
 * UserSearchModule, the onboarding follow-up UserOnboardingModule.
 */
@Module({
  imports: [
    CqrsModule,
    DocumentsModule.forRoot(),
    OutboxModule.forRoot(),
    CacheModule.forRoot(),
    KvModule.forRoot(),
    DedupModule.forRoot(),
    RateLimitModule.forRoot(),
    RealtimeModule.forRoot(),
    TenantDirectoryModule,
    MongooseModule.forFeature([
      { name: User.name, schema: UserSchema },
      { name: UserEvent.name, schema: UserEventSchema },
    ]),
  ],
  providers: [
    UserService,
    SignupPolicyService,
    UserRepository,
    UserEventHandlers,
    UserEventStoreService,
    ...CommandHandlers,
    ...QueryHandlers,
  ],
  exports: [UserService, UserRepository],
})
export class UserModule {}
