import { ExecutionContext, CallHandler } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { of, throwError, firstValueFrom } from 'rxjs';
import * as jwt from 'jsonwebtoken';
import { AuditInterceptor } from '../../../common/interceptors/audit.interceptor';
import { AuditLogService } from '../services/audit-log.service';
import { AUDIT_OUTCOME } from '../constants';

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

  const rpcContext = (metadata: unknown): ExecutionContext =>
    ({
      getType: () => 'rpc',
      getHandler: () => function update() {},
      getClass: () => class GrpcUserService {},
      switchToRpc: () => ({ getContext: () => metadata }),
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
        timestamp: expect.any(Date),
        traceId: expect.any(String),
      }),
    );
  });

  it('records an anonymous entry when no user on the request', async () => {
    reflector.getAllAndOverride.mockReturnValue('auth.login');
    const req = { method: 'POST', originalUrl: '/api/auth/login' };

    await firstValueFrom(interceptor.intercept(httpContext(req), next()));

    expect(auditLog.record).toHaveBeenCalledWith(
      expect.objectContaining({
        actorUserId: '',
        tenantId: 'default',
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

  it('extracts actor and tenant from the bearer token for gRPC calls', async () => {
    reflector.getAllAndOverride.mockReturnValue('user.update');
    const token = jwt.sign({ sub: 'user-9', tenantId: 'acme' }, 'irrelevant');
    const metadata = {
      get: (k: string) => (k === 'authorization' ? [`Bearer ${token}`] : []),
    };

    await firstValueFrom(interceptor.intercept(rpcContext(metadata), next()));

    expect(auditLog.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'user.update',
        actorUserId: 'user-9',
        tenantId: 'acme',
        resource: 'GrpcUserService.update',
        transport: 'rpc',
        outcome: AUDIT_OUTCOME.SUCCESS,
      }),
    );
  });

  it('handles gRPC calls without a token (anonymous actor)', async () => {
    reflector.getAllAndOverride.mockReturnValue('user.create');
    const metadata = { get: () => [] };

    await firstValueFrom(interceptor.intercept(rpcContext(metadata), next()));

    expect(auditLog.record).toHaveBeenCalledWith(
      expect.objectContaining({
        actorUserId: '',
        tenantId: 'default',
        transport: 'rpc',
      }),
    );
  });
});
