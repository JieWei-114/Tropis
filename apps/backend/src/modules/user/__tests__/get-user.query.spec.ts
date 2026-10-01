import { InMemoryCacheStore } from '../../../infrastructure/cache/__tests__/in-memory-cache.store';
import { CacheClient } from '../../../infrastructure/cache/cache.client';
import type { TenantContext } from '../../../common/tenant/tenant.context';
import { toTenantId } from '../../../common/keyspace';
import { GetUserHandler, GetUserQuery } from '../queries/get-user.query';
import type { UserRepository } from '../repositories/user.repository';
import { UserStatus } from '../constants/user.enums';

/**
 * The profile read cache must be keyed per tenant. A key shared by all
 * tenants (`user:<id>`) lets a request from tenant B for an id cached by
 * tenant A return A's user without the tenant-filtered repository query ever
 * running.
 */
describe('GetUserHandler', () => {
  const USER_ID = '6650c1a2b3c4d5e6f7a8b9c0';
  const users: Record<string, { tenantId: string; name: string }> = {
    [`acme:${USER_ID}`]: { tenantId: 'acme', name: 'Alice (acme)' },
  };

  let tenant = 'acme';
  let repo: { findById: jest.Mock };
  let handler: GetUserHandler;

  beforeEach(() => {
    tenant = 'acme';
    repo = {
      // A tenant-filtered lookup, like the real repository.
      findById: jest.fn((tenantId: string, id: string) => {
        const user = users[`${tenantId}:${id}`];
        return Promise.resolve(
          user
            ? {
                _id: { toString: () => id },
                name: user.name,
                email: 'alice@example.com',
                status: UserStatus.ACTIVE,
                roles: [],
                loginCount: 0,
                tenantId: user.tenantId,
              }
            : null,
        );
      }),
    };
    const tenantCtx = {
      get tenantId() {
        return tenant;
      },
      get tenant() {
        return toTenantId(tenant);
      },
    } as unknown as TenantContext;
    handler = new GetUserHandler(
      repo as unknown as UserRepository,
      new CacheClient(new InMemoryCacheStore()),
      tenantCtx,
    );
  });

  it("does not serve tenant A's cached user to tenant B", async () => {
    await expect(
      handler.execute(new GetUserQuery(USER_ID)),
    ).resolves.toMatchObject({ name: 'Alice (acme)' });

    tenant = 'globex';
    await expect(
      handler.execute(new GetUserQuery(USER_ID)),
    ).rejects.toMatchObject({ code: 'USER_NOT_FOUND' });
    expect(repo.findById).toHaveBeenLastCalledWith('globex', USER_ID);
  });

  it('serves repeat reads of the same tenant from the cache', async () => {
    await handler.execute(new GetUserQuery(USER_ID));
    await handler.execute(new GetUserQuery(USER_ID));

    expect(repo.findById).toHaveBeenCalledTimes(1);
  });

  it('shares one repository load between concurrent misses', async () => {
    await Promise.all([
      handler.execute(new GetUserQuery(USER_ID)),
      handler.execute(new GetUserQuery(USER_ID)),
      handler.execute(new GetUserQuery(USER_ID)),
    ]);

    expect(repo.findById).toHaveBeenCalledTimes(1);
  });

  it('does not cache a miss', async () => {
    tenant = 'globex';
    await handler.execute(new GetUserQuery(USER_ID)).catch(() => undefined);
    await handler.execute(new GetUserQuery(USER_ID)).catch(() => undefined);

    expect(repo.findById).toHaveBeenCalledTimes(2);
  });
});
