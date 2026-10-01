import { toTenantId } from '../../../common/keyspace';
import type { CachePort } from '../../../infrastructure/cache/cache.port';
import type { TenantRepository } from '../repositories/tenant.repository';
import { TenantDirectoryService } from '../services/tenant-directory.service';
import { TENANT_RECORD_CACHE } from '../constants/tenant.constants';

describe('TenantDirectoryService', () => {
  const ACME = toTenantId('acme');
  let repo: { findById: jest.Mock; upsert: jest.Mock };
  let cache: { getOrLoad: jest.Mock; del: jest.Mock };
  let directory: TenantDirectoryService;

  beforeEach(() => {
    repo = {
      findById: jest.fn().mockResolvedValue(null),
      upsert: jest.fn((t: Record<string, unknown>) => Promise.resolve(t)),
    };
    cache = {
      getOrLoad: jest.fn((_k: unknown, _t: number, load: () => unknown) =>
        load(),
      ),
      del: jest.fn().mockResolvedValue(undefined),
    };
    directory = new TenantDirectoryService(
      repo as unknown as TenantRepository,
      cache as unknown as CachePort,
    );
  });

  it('reports an unregistered tenant as null', async () => {
    await expect(directory.find(ACME)).resolves.toBeNull();
    expect(cache.getOrLoad).toHaveBeenCalledWith(
      TENANT_RECORD_CACHE.forTenant(ACME),
      60,
      expect.any(Function),
    );
  });

  it('maps a registered tenant', async () => {
    repo.findById.mockResolvedValue({
      _id: 'acme',
      name: 'Acme',
      status: 'active',
      selfSignup: true,
    });
    await expect(directory.find(ACME)).resolves.toEqual({
      id: ACME,
      name: 'Acme',
      status: 'active',
      selfSignup: true,
    });
  });

  it('registers closed to self sign-up by default and drops the cached record', async () => {
    await expect(
      directory.register({ id: ACME, name: 'Acme' }),
    ).resolves.toEqual({
      id: ACME,
      name: 'Acme',
      status: 'active',
      selfSignup: false,
    });
    expect(cache.del).toHaveBeenCalledWith(TENANT_RECORD_CACHE.forTenant(ACME));
  });

  it('rejects a malformed tenant id', async () => {
    await expect(
      directory.register({ id: 'bad tenant' as never, name: 'x' }),
    ).rejects.toMatchObject({ code: 'TENANT_INVALID' });
  });
});
