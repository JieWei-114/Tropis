import { ExecutionContext, CallHandler } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { of, throwError, firstValueFrom } from 'rxjs';
import { AuditInterceptor } from '../audit.interceptor';
import { AuditLogService } from '../audit-log.service';
import { AUDIT_OUTCOME } from '../audit.constants';

describe('AuditInterceptor', () => {
  let interceptor: AuditInterceptor;
  let reflector: { getAllAndOverride: jest.Mock };
  let auditLog: { record: jest.Mock };

  const next = (result$ = of('ok')): CallHandler => ({
    handle: jest.fn().mockReturnValue(result$),
  });

  const httpContext = (req: unknown): ExecutionContext =>
    ({
      getType: () => 'http',
      getHandler: () => function login() {},
      getClass: () => class AuthController {},
      switchToHttp: () => ({ getRequest: () => req }),
    }) as unknown as ExecutionContext;

  const nonHttpContext = (): ExecutionContext =>
    ({
      getType: () => 'ws',
      getHandler: () => function update() {},
      getClass: () => class NotificationGateway {},
    }) as unknown as ExecutionContext;

  beforeEach(() => {
    reflector = { getAllAndOverride: jest.fn() };
    auditLog = { record: jest.fn() };
    interceptor = new AuditInterceptor(
      reflector as unknown as Reflector,
      auditLog as unknown as AuditLogService,
    );
  });

  it('does nothing for handlers without @Audited', async () => {
    reflector.getAllAndOverride.mockReturnValue(undefined);
    const handler = next();

    await firstValueFrom(
      interceptor.intercept(httpContext({ method: 'GET', url: '/x' }), handler),
    );

    expect(auditLog.record).not.toHaveBeenCalled();
  });

  it('records a success entry with actor/tenant from req.user (HTTP)', async () => {
    reflector.getAllAndOverride.mockReturnValue('auth.logout');
    const req = {
      method: 'POST',
      originalUrl: '/api/auth/logout',
      user: { userId: 'user-1', tenantId: 'acme' },
    };

    await firstValueFrom(interceptor.intercept(httpContext(req), next()));

    expect(auditLog.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'auth.logout',
        actorUserId: 'user-1',
        tenantId: 'acme',
        resource: 'POST /api/auth/logout',
        transport: 'http',
        outcome: AUDIT_OUTCOME.SUCCESS,
        timestamp: expect.any(Date) as unknown,
        traceId: expect.any(String) as unknown,
      }),
    );
  });

  it('records an anonymous entry under the resolved tenant hint', async () => {
    reflector.getAllAndOverride.mockReturnValue('auth.login');
    const req = {
      method: 'POST',
      originalUrl: '/api/auth/login',
      tenantId: 'acme',
    };

    await firstValueFrom(interceptor.intercept(httpContext(req), next()));

    expect(auditLog.record).toHaveBeenCalledWith(
      expect.objectContaining({
        actorUserId: '',
        tenantId: 'acme',
        outcome: AUDIT_OUTCOME.SUCCESS,
      }),
    );
  });

  it('records an error entry and rethrows on handler failure', async () => {
    reflector.getAllAndOverride.mockReturnValue('user.delete');
    const boom = new Error('nope');

    await expect(
      firstValueFrom(
        interceptor.intercept(
          httpContext({ method: 'DELETE', url: '/api/users/1' }),
          next(throwError(() => boom)),
        ),
      ),
    ).rejects.toBe(boom);

    expect(auditLog.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'user.delete',
        outcome: AUDIT_OUTCOME.ERROR,
        error: 'nope',
      }),
    );
  });

  it('leaves non-HTTP contexts to their own transport', async () => {
    reflector.getAllAndOverride.mockReturnValue('user.update');

    await firstValueFrom(interceptor.intercept(nonHttpContext(), next()));

    expect(auditLog.record).not.toHaveBeenCalled();
  });
});
