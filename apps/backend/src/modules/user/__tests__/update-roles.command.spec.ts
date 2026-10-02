import { toTenantId } from '../../../common/keyspace';
import type { TenantContext } from '../../../common/tenant/tenant.context';
import type { CachePort } from '../../../infrastructure/cache/cache.port';
import type { DocumentsPort } from '../../../infrastructure/documents/documents.port';
import type { OutboxService } from '../../../infrastructure/outbox/outbox.service';
import {
  UpdateRolesCommand,
  UpdateRolesHandler,
} from '../commands/update-roles.command';
import {
  USER_EVENTS,
  USER_PROFILE_CACHE,
  USER_TOPIC,
} from '../constants/user.constants';
import { UserRole, UserStatus } from '../constants/user.enums';
import type { UserEventStoreService } from '../event-store/user-event-store.service';
import type { UserRepository } from '../repositories/user.repository';

const TENANT = toTenantId('acme');
const ID = '64b7f0c2a1b2c3d4e5f60718';

const doc = (roles: UserRole[]) => ({
  _id: { toString: () => ID },
  name: 'Ada',
  email: 'ada@example.com',
  status: UserStatus.ACTIVE,
  roles,
  loginCount: 0,
  tokenVersion: 1,
});

describe('UpdateRolesHandler', () => {
  let repo: {
    findById: jest.Mock;
    updateRoles: jest.Mock;
    touchOtherAdmins: jest.Mock;
  };
  let outbox: { write: jest.Mock };
  let eventStore: { append: jest.Mock };
  let cache: { del: jest.Mock };
  let handler: UpdateRolesHandler;

  beforeEach(() => {
    repo = {
      findById: jest.fn().mockResolvedValue(doc([UserRole.ADMIN])),
      updateRoles: jest.fn((_t: unknown, _id: string, roles: UserRole[]) =>
        Promise.resolve(doc(roles)),
      ),
      touchOtherAdmins: jest.fn().mockResolvedValue(1),
    };
    outbox = { write: jest.fn().mockResolvedValue(undefined) };
    eventStore = { append: jest.fn().mockResolvedValue(undefined) };
    cache = { del: jest.fn().mockResolvedValue(undefined) };
    handler = new UpdateRolesHandler(
      repo as unknown as UserRepository,
      eventStore as unknown as UserEventStoreService,
      outbox as unknown as OutboxService,
      cache as unknown as CachePort,
      {
        withTransaction: (fn: (tx: unknown) => Promise<unknown>) => fn({}),
      } as unknown as DocumentsPort,
      { tenant: TENANT } as unknown as TenantContext,
    );
  });

  // Reproduces the gap: a role change wrote no event, so search, graph and
  // every other projection kept the old roles, and nothing recorded it.
  it('writes identity.user.updated with the new roles to the outbox in the same transaction', async () => {
    await handler.execute(new UpdateRolesCommand(ID, [UserRole.EDITOR]));
    expect(outbox.write).toHaveBeenCalledWith(
      expect.objectContaining({
        topic: USER_TOPIC,
        aggregateId: ID,
        type: USER_EVENTS.UPDATED,
        tenantId: TENANT,
        data: expect.objectContaining({
          userId: ID,
          roles: [UserRole.EDITOR],
          status: UserStatus.ACTIVE,
        }) as unknown,
      }),
      expect.anything(),
    );
    expect(eventStore.append).toHaveBeenCalledWith(
      TENANT,
      ID,
      'UserUpdated',
      { roles: [UserRole.EDITOR] },
      expect.anything(),
    );
  });

  it('bumps the token version so sessions holding the old roles end', async () => {
    await handler.execute(new UpdateRolesCommand(ID, [UserRole.EDITOR]));
    expect(repo.updateRoles).toHaveBeenCalledWith(
      TENANT,
      ID,
      [UserRole.EDITOR],
      expect.anything(),
    );
  });

  // Reproduces the race: the last-admin check counted admins outside any
  // transaction, so two admins demoting each other at once both passed it.
  it('refuses to demote the last admin, inside the transaction', async () => {
    repo.touchOtherAdmins.mockResolvedValue(0);
    await expect(
      handler.execute(new UpdateRolesCommand(ID, [UserRole.MEMBER])),
    ).rejects.toMatchObject({ code: 'USER_LAST_ADMIN' });
    expect(repo.touchOtherAdmins).toHaveBeenCalledWith(
      TENANT,
      ID,
      expect.anything(),
    );
    expect(repo.updateRoles).not.toHaveBeenCalled();
    expect(outbox.write).not.toHaveBeenCalled();
  });

  it('does not lock other admins when the target keeps admin', async () => {
    await handler.execute(
      new UpdateRolesCommand(ID, [UserRole.ADMIN, UserRole.EDITOR]),
    );
    expect(repo.touchOtherAdmins).not.toHaveBeenCalled();
  });

  it('answers USER_NOT_FOUND for an unknown user', async () => {
    repo.findById.mockResolvedValue(null);
    await expect(
      handler.execute(new UpdateRolesCommand(ID, [UserRole.EDITOR])),
    ).rejects.toMatchObject({ code: 'USER_NOT_FOUND' });
  });

  it('drops the cached profile after the change', async () => {
    await handler.execute(new UpdateRolesCommand(ID, [UserRole.EDITOR]));
    expect(cache.del).toHaveBeenCalledWith(
      USER_PROFILE_CACHE.forTenant(TENANT, ID),
    );
  });
});
