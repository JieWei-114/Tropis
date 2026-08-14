import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { MulterModule } from '@nestjs/platform-express';
import { CqrsModule } from '@nestjs/cqrs';
import { User, UserSchema } from './schemas/user.schema';
import { UserService } from './services/user.service';
import { UserRepository } from './repositories/user.repository';
import { UserProcessor } from './processors/user.processor';
import { UserController } from './controllers/user.controller';
import { UserEventHandlers } from './events/user-event.handlers';
import { SearchModule } from '../../infrastructure/elasticsearch/search.module';
import { PostgresModule } from '../../infrastructure/postgres/postgres.module';
import { CreateUserHandler } from './commands/create-user.command';
import { UpdateUserHandler } from './commands/update-user.command';
import { DeleteUserHandler } from './commands/delete-user.command';
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
];
const QueryHandlers = [GetUserHandler, ListUsersHandler];

@Module({
  imports: [
    CqrsModule,
    MongooseModule.forFeature([
      { name: User.name, schema: UserSchema },
      { name: UserEvent.name, schema: UserEventSchema },
    ]),
    MulterModule.register({ storage: undefined }), // memory storage — buffer passed to MinIO
    SearchModule,
    PostgresModule,
  ],
  controllers: [UserController],
  providers: [
    UserService,
    UserRepository,
    UserProcessor,
    UserEventHandlers,
    UserEventStoreService,
    ...CommandHandlers,
    ...QueryHandlers,
  ],
  exports: [UserService, UserRepository],
})
export class UserModule {}
