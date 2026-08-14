import { ICommand, CommandHandler, ICommandHandler } from '@nestjs/cqrs';
import { NotFoundException, Inject } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { InjectConnection } from '@nestjs/mongoose';
import type { Connection } from 'mongoose';
import type Redis from 'ioredis';
import { UserRepository } from '../repositories/user.repository';
import { USER_ERROR_CODES, USER_EVENTS } from '../constants/user.constants';
import { UserDeletedEvent } from '../events/user.events';
import { UserEventStoreService } from '../event-store/user-event-store.service';
import { OutboxService } from '../../../infrastructure/outbox/outbox.service';
import { REDIS_CLIENT } from '../../../infrastructure/redis/redis.module';
import { UserDocument } from '../schemas/user.schema';

export class DeleteUserCommand implements ICommand {
  constructor(public readonly id: string) {}
}

// Returns the deleted user's email so the caller can use it for audit logs without a second DB hit
@CommandHandler(DeleteUserCommand)
export class DeleteUserHandler implements ICommandHandler<
  DeleteUserCommand,
  string
> {
  constructor(
    private readonly userRepo: UserRepository,
    private readonly eventStore: UserEventStoreService,
    private readonly outboxService: OutboxService,
    private readonly eventEmitter: EventEmitter2,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    @InjectConnection() private readonly connection: Connection,
  ) {}

  async execute(cmd: DeleteUserCommand): Promise<string> {
    const session = await this.connection.startSession();
    let user: UserDocument | null = null;

    try {
      await session.withTransaction(async () => {
        user = await this.userRepo.deleteWithSession(cmd.id, session);
        if (!user) throw new NotFoundException(USER_ERROR_CODES.NOT_FOUND);

        await this.eventStore.appendWithSession(
          cmd.id,
          'UserDeleted',
          { email: user.email },
          session,
        );
        await this.outboxService.write(
          cmd.id,
          USER_EVENTS.DELETED,
          { userId: cmd.id, email: user.email },
          session,
        );
      });
    } finally {
      await session.endSession();
    }

    const userEmail = user!.email;

    await this.redis.del(`user:${cmd.id}`);
    this.eventEmitter.emit(
      UserDeletedEvent.EVENT,
      new UserDeletedEvent(cmd.id, userEmail),
    );

    return userEmail;
  }
}
