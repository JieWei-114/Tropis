import type { CallHandler, ExecutionContext } from '@nestjs/common';
import { Observable, firstValueFrom } from 'rxjs';
import { AppError } from '../../errors';
import { HttpTenantInterceptor } from '../http-tenant.interceptor';
import { TenantContext } from '../../tenant/tenant.context';

describe('HttpTenantInterceptor', () => {
  const tenantCtx = new TenantContext();
  const interceptor = new HttpTenantInterceptor();

  const httpContext = (req: unknown) =>
    ({
      getType: () => 'http',
      switchToHttp: () => ({ getRequest: () => req }),
    }) as unknown as ExecutionContext;

  /** Reads the tenant when the handler actually runs (on subscribe). */
  const handler: CallHandler = {
    handle: () =>
      new Observable((s) => {
        try {
          s.next(tenantCtx.tenantId);
          s.complete();
        } catch (err) {
          s.error(err);
        }
      }),
  };

  const errorCode = (p: Promise<unknown>) =>
    p.then(
      () => 'resolved',
      (e: { code?: string }) => e.code,
    );

  it('binds the tenant TenantMiddleware resolved for the handler', async () => {
    await expect(
      firstValueFrom(
        interceptor.intercept(httpContext({ tenantId: 'acme' }), handler),
      ),
    ).resolves.toBe('acme');
  });

  it('has no fallback tenant: a tenant read without one is TENANT_REQUIRED', async () => {
    await expect(
      errorCode(
        firstValueFrom(interceptor.intercept(httpContext({}), handler)),
      ),
    ).resolves.toBe('TENANT_REQUIRED');
  });

  it('rethrows the resolution error recorded by the middleware', async () => {
    await expect(
      errorCode(
        firstValueFrom(
          interceptor.intercept(
            httpContext({ tenantError: new AppError('TENANT_MISMATCH') }),
            handler,
          ),
        ),
      ),
    ).resolves.toBe('TENANT_MISMATCH');
  });

  it('leaves non-HTTP contexts alone', async () => {
    const ws = { getType: () => 'ws' } as unknown as ExecutionContext;
    await expect(
      errorCode(firstValueFrom(interceptor.intercept(ws, handler))),
    ).resolves.toBe('TENANT_REQUIRED');
  });
});
