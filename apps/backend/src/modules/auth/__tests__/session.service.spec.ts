import { toTenantId } from '../../../common/keyspace';
import { InMemoryKvAdapter } from '../../../infrastructure/kv/__tests__/in-memory-kv.adapter';
import { SESSION_KEY, SESSION_TTL_SECONDS } from '../constants/auth.constants';
import { SessionService } from '../services/session.service';

describe('SessionService', () => {
  const ACME = toTenantId('acme');
  const GLOBEX = toTenantId('globex');
  let kv: InMemoryKvAdapter;
  let service: SessionService;

  beforeEach(() => {
    kv = new InMemoryKvAdapter();
    service = new SessionService(kv);
  });

  it('stores the session under a tenant-scoped key with the 7-day TTL', async () => {
    const set = jest.spyOn(kv, 'set');
    await service.create(ACME, 'user-1', 'a@example.com', '10.0.0.1');

    expect(set).toHaveBeenCalledWith(
      SESSION_KEY.forTenant(ACME, 'user-1'),
      expect.objectContaining({
        userId: 'user-1',
        email: 'a@example.com',
        ip: '10.0.0.1',
      }),
      { ttlSeconds: SESSION_TTL_SECONDS },
    );
    await expect(service.get(ACME, 'user-1')).resolves.toMatchObject({
      userId: 'user-1',
    });
  });

  it('keeps sessions of the same user id apart per tenant', async () => {
    await service.create(ACME, 'user-1', 'a@example.com');
    await expect(service.get(GLOBEX, 'user-1')).resolves.toBeNull();
  });

  it('removes the session on invalidate', async () => {
    await service.create(ACME, 'user-1', 'a@example.com');
    await service.invalidate(ACME, 'user-1');
    await expect(service.get(ACME, 'user-1')).resolves.toBeNull();
  });

  it('degrades to a no-op when kv fails', async () => {
    jest.spyOn(kv, 'set').mockRejectedValue(new Error('down'));
    jest.spyOn(kv, 'get').mockRejectedValue(new Error('down'));
    jest.spyOn(kv, 'del').mockRejectedValue(new Error('down'));

    await expect(
      service.create(ACME, 'user-1', 'a@example.com'),
    ).resolves.toBeUndefined();
    await expect(service.get(ACME, 'user-1')).resolves.toBeNull();
    await expect(service.invalidate(ACME, 'user-1')).resolves.toBeUndefined();
  });
});
