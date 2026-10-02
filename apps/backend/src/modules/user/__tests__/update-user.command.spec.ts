import type { EventEmitter2 } from '@nestjs/event-emitter';
import { toTenantId } from '../../../common/keyspace';
import type { TenantContext } from '../../../common/tenant/tenant.context';
import type { CachePort } from '../../../infrastructure/cache/cache.port';
import type { DocumentsPort } from '../../../infrastructure/documents/documents.port';
import type { OutboxService } from '../../../infrastructure/outbox/outbox.service';
import {
  UpdateUserCommand,
  UpdateUserHandler,
} from '../commands/update-user.command';
import {
  DeleteUserCommand,
  DeleteUserHandler,
} from '../commands/delete-user.command';
import { UserRole, UserStatus } from '../constants/user.enums';
import type { UserEventStoreService } from '../event-store/user-event-store.service';
import type { UserRepository } from '../repositories/user.repository';

const TENANT = toTenantId('acme');
const ID = '64b7f0c2a1b2c3d4e5f60718';

const doc = (overrides: Record<string, unknown> = {}) => ({
  _id: { toString: () => ID },
  name: 'Ada',
  email: 'ada@example.com',
  status: UserStatus.ACTIVE,
  roles: [UserRole.MEMBER],
  loginCount: 0,
  tokenVersion: 0,
  ...overrides,
});

describe('UpdateUserHandler', () => {
  let repo: {
    findById: jest.Mock;
    update: jest.Mock;
    touchOtherAdmins: jest.Mock;
  };
  let outbox: { write: jest.Mock };
  let handler: UpdateUserHandler;

  beforeEach(() => {
    repo = {
      findById: jest.fn().mockResolvedValue(doc()),
      update: jest.fn((_t: unknown, _id: string, data: object) =>
        Promise.resolve(doc(data as Record<string, unknown>)),
      ),
      touchOtherAdmins: jest.fn().mockResolvedValue(1),
    };
    outbox = { write: jest.fn().mockResolvedValue(undefined) };
    handler = new UpdateUserHandler(
      repo as unknown as UserRepository,
      { append: jest.fn() } as unknown as UserEventStoreService,
      outbox as unknown as OutboxService,
      { emit: jest.fn() } as unknown as EventEmitter2,
      { del: jest.fn().mockResolvedValue(undefined) } as unknown as CachePort,
      {
        withTransaction: (fn: (tx: unknown) => Promise<unknown>) => fn({}),
      } as unknown as DocumentsPort,
      { tenant: TENANT } as unknown as TenantContext,
    );
  });

  const endedSessions = () =>
    (
      (repo.update.mock.calls[0] as unknown[])[4] as
        | { endSessions?: boolean }
        | undefined
    )?.endSessions === true;

  // Reproduces the gap: changing the password (or email, or status) left
  // every session issued before it working.
  it.each([
    ['the password', { password: 'new-password-1' }],
    ['the email', { email: 'other@example.com' }],
    ['the status', { status: UserStatus.INACTIVE }],
  ])('ends existing sessions when %s changes', async (_label, patch) => {
    await handler.execute(new UpdateUserCommand(ID, patch));
    expect(endedSessions()).toBe(true);
  });

  it('keeps sessions for a profile-only change', async () => {
    await handler.execute(new UpdateUserCommand(ID, { name: 'Ada L.' }));
    expect(endedSessions()).toBe(false);
  });

  it('keeps sessions when the email is restated unchanged', async () => {
    await handler.execute(
      new UpdateUserCommand(ID, { email: 'ADA@example.com' }),
    );
    expect(endedSessions()).toBe(false);
  });

  it('carries the roles and status in identity.user.updated', async () => {
    await handler.execute(new UpdateUserCommand(ID, { name: 'Ada L.' }));
    expect(
      (outbox.write.mock.calls[0] as Parameters<OutboxService['write']>)[0]
        .data,
    ).toMatchObject({
      roles: [UserRole.MEMBER],
      status: UserStatus.ACTIVE,
    });
  });

  it('refuses to deactivate the last active admin', async () => {
    repo.findById.mockResolvedValue(doc({ roles: [UserRole.ADMIN] }));
    repo.touchOtherAdmins.mockResolvedValue(0);
    await expect(
      handler.execute(
        new UpdateUserCommand(ID, { status: UserStatus.INACTIVE }),
      ),
    ).rejects.toMatchObject({ code: 'USER_LAST_ADMIN' });
    expect(repo.update).not.toHaveBeenCalled();
  });
});

describe('DeleteUserHandler', () => {
  it('refuses to delete the last active admin', async () => {
    const repo = {
      findById: jest.fn().mockResolvedValue(doc({ roles: [UserRole.ADMIN] })),
      touchOtherAdmins: jest.fn().mockResolvedValue(0),
      delete: jest.fn(),
    };
    const handler = new DeleteUserHandler(
      repo as unknown as UserRepository,
      { append: jest.fn() } as unknown as UserEventStoreService,
      { write: jest.fn() } as unknown as OutboxService,
      { del: jest.fn() } as unknown as CachePort,
      {
        withTransaction: (fn: (tx: unknown) => Promise<unknown>) => fn({}),
      } as unknown as DocumentsPort,
      { tenant: TENANT } as unknown as TenantContext,
    );
    await expect(
      handler.execute(new DeleteUserCommand(ID)),
    ).rejects.toMatchObject({ code: 'USER_LAST_ADMIN' });
    expect(repo.delete).not.toHaveBeenCalled();
  });
});
