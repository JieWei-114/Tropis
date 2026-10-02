import type { EventEmitter2 } from '@nestjs/event-emitter';
import type { DocumentsPort } from '../../../infrastructure/documents/documents.port';
import { toTenantId } from '../../../common/keyspace';
import type { TenantContext } from '../../../common/tenant/tenant.context';
import { InMemoryDedupAdapter } from '../../../infrastructure/dedup/__tests__/in-memory-dedup.adapter';
import { InMemoryKvAdapter } from '../../../infrastructure/kv/__tests__/in-memory-kv.adapter';
import type { OutboxService } from '../../../infrastructure/outbox/outbox.service';
import {
  CreateUserCommand,
  CreateUserHandler,
} from '../commands/create-user.command';
import {
  CREATE_RESPONSE_KEY,
  USER_EVENTS,
  USER_TOPIC,
} from '../constants/user.constants';
import type { UserEventStoreService } from '../event-store/user-event-store.service';
import type { UserRepository } from '../repositories/user.repository';

describe('CreateUserHandler idempotency', () => {
  let tenant = 'acme';
  let repo: { findByEmail: jest.Mock; create: jest.Mock };
  let outbox: { write: jest.Mock };
  let dedup: InMemoryDedupAdapter;
  let kv: InMemoryKvAdapter;
  let handler: CreateUserHandler;

  const command = (key?: string, requester = 'ip:203.0.113.9') =>
    new CreateUserCommand(
      'Ada',
      'ada@example.com',
      'password-1',
      36,
      key,
      undefined,
      requester,
    );

  beforeEach(() => {
    tenant = 'acme';
    let seq = 0;
    repo = {
      findByEmail: jest.fn().mockResolvedValue(null),
      create: jest.fn((data: Record<string, unknown>) =>
        Promise.resolve({
          ...data,
          _id: { toString: () => `user-${++seq}` },
          status: 'active',
          roles: [],
          loginCount: 0,
        }),
      ),
    };
    outbox = { write: jest.fn().mockResolvedValue(undefined) };
    dedup = new InMemoryDedupAdapter();
    kv = new InMemoryKvAdapter();
    const documents = {
      withTransaction: (fn: (tx: unknown) => Promise<unknown>) => fn({}),
    };
    handler = new CreateUserHandler(
      repo as unknown as UserRepository,
      {
        append: jest.fn().mockResolvedValue(undefined),
      } as unknown as UserEventStoreService,
      outbox as unknown as OutboxService,
      { emit: jest.fn() } as unknown as EventEmitter2,
      documents as unknown as DocumentsPort,
      dedup,
      kv,
      {
        get tenantId() {
          return tenant;
        },
        get tenant() {
          return toTenantId(tenant);
        },
      } as unknown as TenantContext,
    );
  });

  const settle = () => new Promise((r) => setImmediate(r));

  it('returns the stored response for a repeat of the same key', async () => {
    const first = await handler.execute(command('key-1'));
    await settle();
    const repeat = await handler.execute(command('key-1'));

    expect(repeat).toEqual(first);
    expect(repo.create).toHaveBeenCalledTimes(1);
  });

  it('keeps idempotency keys apart per tenant', async () => {
    await handler.execute(command('key-1'));
    await settle();

    tenant = 'globex';
    await handler.execute(command('key-1'));

    expect(repo.create).toHaveBeenCalledTimes(2);
    await expect(
      kv.exists(
        CREATE_RESPONSE_KEY.forTenant(
          toTenantId('globex'),
          'ip:203.0.113.9',
          'key-1',
        ),
      ),
    ).resolves.toBe(true);
  });

  // Reproduces the gap: the key was scoped to the tenant only, so another
  // caller who guessed or saw a key received the first caller's response.
  it('keeps idempotency keys apart per caller', async () => {
    const first = await handler.execute(command('key-1', 'user:admin-1'));
    await settle();
    repo.findByEmail.mockResolvedValue(null);

    const other = await handler.execute(command('key-1', 'ip:198.51.100.7'));

    expect(repo.create).toHaveBeenCalledTimes(2);
    expect(other.id).not.toBe(first.id);
  });

  it('frees the key when the create fails, so a retry runs again', async () => {
    repo.findByEmail.mockResolvedValueOnce({ _id: 'existing' });
    await expect(handler.execute(command('key-1'))).rejects.toMatchObject({
      code: 'USER_ALREADY_EXISTS',
    });

    await handler.execute(command('key-1'));
    expect(repo.create).toHaveBeenCalledTimes(1);
  });

  it('writes the tenant into the outbox event payload', async () => {
    await handler.execute(command());

    expect(outbox.write).toHaveBeenCalledWith(
      expect.objectContaining({
        topic: USER_TOPIC,
        aggregateId: 'user-1',
        type: USER_EVENTS.CREATED,
        tenantId: 'acme',
        data: expect.objectContaining({
          userId: 'user-1',
          tenantId: 'acme',
        }) as unknown,
      }),
      expect.anything(),
    );
  });

  it('emits the event under its current name only', async () => {
    await handler.execute(command());

    const types = outbox.write.mock.calls.map(
      ([event]: Parameters<OutboxService['write']>) => event.type,
    );
    expect(types).toEqual(['identity.user.created']);
  });
});
