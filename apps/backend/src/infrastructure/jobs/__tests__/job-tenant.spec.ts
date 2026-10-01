import { toTenantId } from '../../../common/keyspace';
import {
  currentTenant,
  isGlobalScope,
  runGlobal,
  runInTenant,
} from '../../../common/tenant/tenant.context';
import {
  attachJobScope,
  captureJobScope,
  detachJobScope,
  JOB_TENANT_FIELD,
  runInJobScope,
} from '../job-tenant';
import { processWithTrace } from '../job-trace';

describe('job tenant scope', () => {
  it('captures the current tenant', () => {
    expect(runInTenant(toTenantId('acme'), captureJobScope)).toEqual({
      scope: 'tenant',
      tenantId: 'acme',
    });
  });

  it('captures an explicit global scope', () => {
    expect(runGlobal(captureJobScope)).toEqual({ scope: 'global' });
  });

  it('rejects capture outside any scope with TENANT_REQUIRED', () => {
    expect(() => captureJobScope()).toThrow(
      expect.objectContaining({ code: 'TENANT_REQUIRED' }),
    );
  });

  it('refuses job data that cannot carry the scope', () => {
    expect(() => attachJobScope('text', { scope: 'global' })).toThrow(
      TypeError,
    );
  });

  it('round-trips the scope through the job data', () => {
    const data = attachJobScope({ a: 1 }, { scope: 'global' });
    expect(data).toEqual({ a: 1, [JOB_TENANT_FIELD]: { scope: 'global' } });
    expect(detachJobScope(data)).toEqual({
      data: { a: 1 },
      scope: { scope: 'global' },
    });
    expect(detachJobScope({ a: 1 })).toEqual({
      data: { a: 1 },
      scope: undefined,
    });
  });

  it('rejects a malformed tenant id in the job data', () => {
    expect(() =>
      detachJobScope({
        [JOB_TENANT_FIELD]: { scope: 'tenant', tenantId: 'bad id!' },
      }),
    ).toThrow(expect.objectContaining({ code: 'TENANT_INVALID' }));
  });

  it('runs an attempt inside its tenant or global scope', async () => {
    await expect(
      runInJobScope({ scope: 'tenant', tenantId: toTenantId('acme') }, () =>
        Promise.resolve(currentTenant()),
      ),
    ).resolves.toBe('acme');
    await expect(
      runInJobScope({ scope: 'global' }, () =>
        Promise.resolve(isGlobalScope()),
      ),
    ).resolves.toBe(true);
  });

  it('fails an attempt whose data carries no scope', async () => {
    const fn = jest.fn();
    await expect(
      processWithTrace(
        'bullmq',
        'notification',
        { id: 'j1', name: 'n', data: { a: 1 }, attemptsMade: 0 },
        fn,
      ),
    ).rejects.toMatchObject({ code: 'TENANT_REQUIRED' });
    expect(fn).not.toHaveBeenCalled();
  });
});
