import { ICommand, CommandHandler, ICommandHandler } from '@nestjs/cqrs';
import { BadRequestException, NotFoundException, Inject } from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { InjectConnection } from '@nestjs/mongoose';
import type { Connection } from 'mongoose';
import type Redis from 'ioredis';
import { UserRepository } from '../repositories/user.repository';
import { UserTransformer } from '../transformers/user.transformer';
import { IUserResponse } from '../interfaces/user.interface';
import { ERROR_CODES } from '@tropis/shared';
import {
  PASSWORD_MIN_LENGTH,
  USER_ERROR_CODES,
  USER_EVENTS,
} from '../constants/user.constants';
import { UserUpdatedEvent } from '../events/user.events';
import { UserEventStoreService } from '../event-store/user-event-store.service';
import { OutboxService } from '../../../infrastructure/outbox/outbox.service';
import { REDIS_CLIENT } from '../../../infrastructure/redis/redis.module';
import { UserStatus, UserDocument } from '../schemas/user.schema';
import { TenantContext } from '../../../common/tenant/tenant.context';

const BCRYPT_SALT = 12;

export class UpdateUserCommand implements ICommand {
  constructor(
    public readonly id: string,
    public readonly patch: {
      name?: string;
      email?: string;
      password?: string;
      age?: number;
      status?: UserStatus;
    },
  ) {}
}

@CommandHandler(UpdateUserCommand)
export class UpdateUserHandler implements ICommandHandler<
  UpdateUserCommand,
  IUserResponse
> {
  constructor(
    private readonly userRepo: UserRepository,
    private readonly eventStore: UserEventStoreService,
    private readonly outboxService: OutboxService,
    private readonly eventEmitter: EventEmitter2,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    @InjectConnection() private readonly connection: Connection,
    private readonly tenantCtx: TenantContext,
  ) {}

  async execute(cmd: UpdateUserCommand): Promise<IUserResponse> {
    const updateData: Record<string, unknown> = { ...cmd.patch };

    if (cmd.patch.password) {
      // Same floor as create: the gRPC path builds this DTO by hand, so
      // class-validator never runs and a 1-char password would otherwise be
      // hashed and stored, locking the account out of REST login.
      if (cmd.patch.password.length < PASSWORD_MIN_LENGTH) {
        throw new BadRequestException({
          code: ERROR_CODES.BAD_REQUEST,
          message: `Password must be at least ${PASSWORD_MIN_LENGTH} characters`,
        });
      }
      updateData.passwordHash = await bcrypt.hash(
        cmd.patch.password,
        BCRYPT_SALT,
      );
      delete updateData.password;
    }

    const eventPayload = { ...cmd.patch } as Record<string, unknown>;
    delete eventPayload.password;

    const session = await this.connection.startSession();
    let user: UserDocument | null = null;

    try {
      await session.withTransaction(async () => {
        user = await this.userRepo.updateWithSession(
          cmd.id,
          updateData,
          session,
          this.tenantCtx.tenantId,
        );
        if (!user) throw new NotFoundException(USER_ERROR_CODES.NOT_FOUND);

        await this.eventStore.appendWithSession(
          cmd.id,
          'UserUpdated',
          eventPayload,
          session,
        );
        // Outbox carries the FULL current fields (not just the patch) so the
        // downstream consumer can do a complete re-index / vector upsert.
        await this.outboxService.write(
          cmd.id,
          USER_EVENTS.UPDATED,
          {
            userId: cmd.id,
            name: user.name,
            email: user.email,
            age: user.age,
            loginCount: user.loginCount,
          },
          session,
        );
      });
    } finally {
      await session.endSession();
    }

    const updatedUser = user!;

    await this.redis.del(`user:${cmd.id}`);

    this.eventEmitter.emit(
      UserUpdatedEvent.EVENT,
      new UserUpdatedEvent(
        cmd.id,
        updatedUser.name,
        updatedUser.email,
        updatedUser.age,
        updatedUser.loginCount,
      ),
    );

    return UserTransformer.toResponse(updatedUser);
  }
}
