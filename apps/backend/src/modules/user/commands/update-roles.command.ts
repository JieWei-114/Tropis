import { ICommand, CommandHandler, ICommandHandler } from '@nestjs/cqrs';
import { Inject } from '@nestjs/common';
import { AppError } from '../../../common/errors';
import { TenantContext } from '../../../common/tenant/tenant.context';
import {
  CACHE,
  type CachePort,
} from '../../../infrastructure/cache/cache.port';
import {
  DOCUMENTS,
  type DocumentsPort,
} from '../../../infrastructure/documents/documents.port';
import { OutboxService } from '../../../infrastructure/outbox/outbox.service';
import {
  USER_ERROR_CODES,
  USER_EVENTS,
  USER_PROFILE_CACHE,
  USER_TOPIC,
} from '../constants/user.constants';
import { UserRole } from '../constants/user.enums';
import { UserEventStoreService } from '../event-store/user-event-store.service';
import { UserRepository } from '../repositories/user.repository';
import type { UserDocument } from '../schemas/user.schema';

export class UpdateRolesCommand implements ICommand {
  constructor(
    public readonly id: string,
    public readonly roles: UserRole[],
  ) {}
}

/**
 * Replaces a user's roles in one transaction with the event-store entry and
 * the `identity.user.updated` outbox event (carrying the roles), and bumps the token
 * version so sessions issued under the old roles end. Demoting an admin
 * requires another active admin, checked inside the same transaction
 * (UserRepository.touchOtherAdmins), so concurrent demotions cannot remove
 * the last one.
 */
@CommandHandler(UpdateRolesCommand)
export class UpdateRolesHandler implements ICommandHandler<
  UpdateRolesCommand,
  UserRole[]
> {
  constructor(
    private readonly userRepo: UserRepository,
    private readonly eventStore: UserEventStoreService,
    private readonly outboxService: OutboxService,
    @Inject(CACHE) private readonly cache: CachePort,
    @Inject(DOCUMENTS) private readonly documents: DocumentsPort,
    private readonly tenantCtx: TenantContext,
  ) {}

  async execute(cmd: UpdateRolesCommand): Promise<UserRole[]> {
    const tenant = this.tenantCtx.tenant;
    const updated = await this.documents.withTransaction(async (tx) => {
      const current = await this.userRepo.findById(tenant, cmd.id, tx);
      if (!current) throw new AppError(USER_ERROR_CODES.NOT_FOUND);

      const demotesAdmin =
        (current.roles ?? []).includes(UserRole.ADMIN) &&
        !cmd.roles.includes(UserRole.ADMIN);
      if (
        demotesAdmin &&
        (await this.userRepo.touchOtherAdmins(tenant, cmd.id, tx)) === 0
      ) {
        throw new AppError(USER_ERROR_CODES.LAST_ADMIN, {
          detail: 'Cannot remove the last admin of this tenant',
        });
      }

      const user: UserDocument | null = await this.userRepo.updateRoles(
        tenant,
        cmd.id,
        cmd.roles,
        tx,
      );
      if (!user) throw new AppError(USER_ERROR_CODES.NOT_FOUND);

      await this.eventStore.append(
        tenant,
        cmd.id,
        'UserUpdated',
        { roles: cmd.roles },
        tx,
      );
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
      return user;
    });

    await this.cache
      .del(USER_PROFILE_CACHE.forTenant(tenant, cmd.id))
      .catch(() => undefined);
    return updated.roles ?? [];
  }
}
