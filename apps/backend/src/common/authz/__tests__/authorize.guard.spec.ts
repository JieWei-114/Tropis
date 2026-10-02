import { AppError } from '../../errors';
import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { PolicyPort } from '../../../infrastructure/policy/policy.port';
import { AuthorizationService } from '../authorization.service';
import { Authorize } from '../authorize.decorator';
import { AuthorizeGuard } from '../authorize.guard';

class Routes {
  @Authorize('user', 'manage_roles')
  guarded(this: void): void {}

  open(this: void): void {}
}

const httpContext = (handler: () => void, user?: { roles: string[] }) =>
  ({
    getType: () => 'http',
    getHandler: () => handler,
    getClass: () => Routes,
    switchToHttp: () => ({ getRequest: () => ({ user }) }),
  }) as unknown as ExecutionContext;

describe('AuthorizeGuard', () => {
  let policy: { allow: jest.Mock };
  let guard: AuthorizeGuard;

  beforeEach(() => {
    policy = { allow: jest.fn().mockResolvedValue(true) };
    guard = new AuthorizeGuard(
      new Reflector(),
      new AuthorizationService(policy as unknown as PolicyPort),
    );
  });

  it('passes a route without @Authorize without asking the policy', async () => {
    await expect(
      guard.canActivate(httpContext(Routes.prototype.open)),
    ).resolves.toBe(true);
    expect(policy.allow).not.toHaveBeenCalled();
  });

  it('asks the policy with the principal roles and the declared permission', async () => {
    await expect(
      guard.canActivate(
        httpContext(Routes.prototype.guarded, { roles: ['admin'] }),
      ),
    ).resolves.toBe(true);
    expect(policy.allow).toHaveBeenCalledWith({
      roles: ['admin'],
      resource: 'user',
      action: 'manage_roles',
    });
  });

  it('answers SERVICE_UNAVAILABLE, not FORBIDDEN, when the policy engine is down', async () => {
    policy.allow.mockRejectedValue(new AppError('SERVICE_UNAVAILABLE'));
    await expect(
      guard.canActivate(
        httpContext(Routes.prototype.guarded, { roles: ['admin'] }),
      ),
    ).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' });
  });

  it('rejects a denied caller with FORBIDDEN', async () => {
    policy.allow.mockResolvedValue(false);
    await expect(
      guard.canActivate(
        httpContext(Routes.prototype.guarded, { roles: ['member'] }),
      ),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('rejects a protected route without a verified principal', async () => {
    await expect(
      guard.canActivate(httpContext(Routes.prototype.guarded)),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });
});
