import { ICommand, CommandHandler, ICommandHandler } from '@nestjs/cqrs';
import { Inject } from '@nestjs/common';
import { AppError } from '../../../common/errors';
import {
  DOCUMENTS,
  type DocumentsPort,
} from '../../../infrastructure/documents/documents.port';
import { UserRepository } from '../repositories/user.repository';
import {
  USER_ERROR_CODES,
  USER_EVENTS,
  USER_PROFILE_CACHE,
  USER_TOPIC,
} from '../constants/user.constants';
import { UserEventStoreService } from '../event-store/user-event-store.service';
import { OutboxService } from '../../../infrastructure/outbox/outbox.service';
import {
  CACHE,
  type CachePort,
} from '../../../infrastructure/cache/cache.port';
import { UserDocument, UserRole } from '../schemas/user.schema';
import { TenantContext } from '../../../common/tenant/tenant.context';

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
    @Inject(CACHE) private readonly cache: CachePort,
    @Inject(DOCUMENTS) private readonly documents: DocumentsPort,
    private readonly tenantCtx: TenantContext,
  ) {}

  async execute(cmd: DeleteUserCommand): Promise<string> {
    const tenant = this.tenantCtx.tenant;
    let user: UserDocument | null = null;

    await this.documents.withTransaction(async (tx) => {
      const current = await this.userRepo.findById(tenant, cmd.id, tx);
      if (!current) throw new AppError(USER_ERROR_CODES.NOT_FOUND);
      if (
        (current.roles ?? []).includes(UserRole.ADMIN) &&
        (await this.userRepo.touchOtherAdmins(tenant, cmd.id, tx)) === 0
      ) {
        throw new AppError(USER_ERROR_CODES.LAST_ADMIN, {
          detail: 'Cannot delete the last admin of this tenant',
        });
      }
      user = await this.userRepo.delete(tenant, cmd.id, tx);
      if (!user) throw new AppError(USER_ERROR_CODES.NOT_FOUND);

      await this.eventStore.append(
        tenant,
        cmd.id,
        'UserDeleted',
        { email: user.email },
        tx,
      );
      await this.outboxService.write(
        {
          topic: USER_TOPIC,
          aggregateId: cmd.id,
          type: USER_EVENTS.DELETED,
          tenantId: tenant,
          data: { userId: cmd.id, tenantId: tenant, email: user.email },
        },
        tx,
      );
    });

    const userEmail = user!.email;

    // Search/vector delete and a second cache purge are driven durably by
    // the broker consumer (UserProcessor) off the outbox row written above.
    await this.cache.del(USER_PROFILE_CACHE.forTenant(tenant, cmd.id));

    return userEmail;
  }
}
