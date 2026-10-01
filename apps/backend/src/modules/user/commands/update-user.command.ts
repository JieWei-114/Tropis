import { ICommand, CommandHandler, ICommandHandler } from '@nestjs/cqrs';
import { Inject } from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  DOCUMENTS,
  type DocumentsPort,
} from '../../../infrastructure/documents/documents.port';
import { UserRepository } from '../repositories/user.repository';
import { UserTransformer } from '../transformers/user.transformer';
import { IUserResponse } from '../interfaces/user.interface';
import { AppError } from '../../../common/errors';
import {
  PASSWORD_MIN_LENGTH,
  USER_ERROR_CODES,
  USER_EVENTS,
  USER_PROFILE_CACHE,
  USER_TOPIC,
} from '../constants/user.constants';
import { UserUpdatedEvent } from '../events/user.events';
import { UserEventStoreService } from '../event-store/user-event-store.service';
import { OutboxService } from '../../../infrastructure/outbox/outbox.service';
import {
  CACHE,
  type CachePort,
} from '../../../infrastructure/cache/cache.port';
import { UserRole, UserStatus, UserDocument } from '../schemas/user.schema';
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
    @Inject(CACHE) private readonly cache: CachePort,
    @Inject(DOCUMENTS) private readonly documents: DocumentsPort,
    private readonly tenantCtx: TenantContext,
  ) {}

  async execute(cmd: UpdateUserCommand): Promise<IUserResponse> {
    const updateData: Record<string, unknown> = { ...cmd.patch };

    if (cmd.patch.password) {
      // Same floor as create: the gRPC path builds this DTO by hand, so
      // class-validator never runs and a 1-char password would otherwise be
      // hashed and stored, locking the account out of REST login.
      if (cmd.patch.password.length < PASSWORD_MIN_LENGTH) {
        throw AppError.validation([
          {
            field: 'password',
            description: `Password must be at least ${PASSWORD_MIN_LENGTH} characters`,
          },
        ]);
      }
      updateData.passwordHash = await bcrypt.hash(
        cmd.patch.password,
        BCRYPT_SALT,
      );
      delete updateData.password;
    }

    const eventPayload = { ...cmd.patch } as Record<string, unknown>;
    delete eventPayload.password;

    const tenant = this.tenantCtx.tenant;
    let user: UserDocument | null = null;

    await this.documents.withTransaction(async (tx) => {
      const current = await this.userRepo.findById(tenant, cmd.id, tx);
      if (!current) throw new AppError(USER_ERROR_CODES.NOT_FOUND);

      const statusChanges =
        cmd.patch.status !== undefined && cmd.patch.status !== current.status;
      const emailChanges =
        cmd.patch.email !== undefined &&
        cmd.patch.email.toLowerCase() !== current.email;
      if (
        statusChanges &&
        cmd.patch.status !== UserStatus.ACTIVE &&
        (current.roles ?? []).includes(UserRole.ADMIN) &&
        (await this.userRepo.touchOtherAdmins(tenant, cmd.id, tx)) === 0
      ) {
        throw new AppError(USER_ERROR_CODES.LAST_ADMIN, {
          detail: 'Cannot deactivate the last admin of this tenant',
        });
      }

      user = await this.userRepo.update(tenant, cmd.id, updateData, tx, {
        endSessions: !!cmd.patch.password || emailChanges || statusChanges,
      });
      if (!user) throw new AppError(USER_ERROR_CODES.NOT_FOUND);

      await this.eventStore.append(
        tenant,
        cmd.id,
        'UserUpdated',
        eventPayload,
        tx,
      );
      // Outbox carries the FULL current fields (not just the patch) so the
      // downstream consumer can do a complete re-index / vector upsert.
      await this.outboxService.write(
        {
          topic: USER_TOPIC,
          aggregateId: cmd.id,
          type: USER_EVENTS.UPDATED,
          tenantId: tenant,
          data: {
            userId: cmd.id,
            tenantId: tenant,
            name: user.name,
            email: user.email,
            age: user.age,
            loginCount: user.loginCount,
            roles: user.roles ?? [],
            status: user.status,
          },
        },
        tx,
      );
    });

    const updatedUser = user!;

    await this.cache.del(USER_PROFILE_CACHE.forTenant(tenant, cmd.id));

    this.eventEmitter.emit(
      UserUpdatedEvent.EVENT,
      new UserUpdatedEvent(
        tenant,
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
