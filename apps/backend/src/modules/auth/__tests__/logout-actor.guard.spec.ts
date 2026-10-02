import type { ExecutionContext } from '@nestjs/common';
import { AppError } from '../../../common/errors';
import { toTenantId } from '../../../common/keyspace';
import { LogoutActorGuard } from '../guards/logout-actor.guard';
import type { AuthService } from '../services/auth.service';
import { REFRESH_COOKIE } from '../constants/auth.constants';

const ACME = toTenantId('acme');

const principal = {
  userId: 'u1',
  email: 'a@example.com',
  roles: [],
  tenantId: ACME,
  jti: 'j',
  exp: 1,
};

function contextFor(req: object): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => req }),
  } as unknown as ExecutionContext;
}

// Reproduces the gap: logout is public, so its audit entry had no actor.
describe('LogoutActorGuard', () => {
  const auth = { refreshTokenOwner: jest.fn() };
  const verifier = { verify: jest.fn() };
  const guard = new LogoutActorGuard(auth as unknown as AuthService, verifier);

  beforeEach(() => {
    jest.resetAllMocks();
    auth.refreshTokenOwner.mockImplementation((t?: string) =>
      t ? { tenantId: ACME, userId: `owner-of-${t}` } : null,
    );
  });

  it('names the access-token principal when one is sent', async () => {
    verifier.verify.mockResolvedValue(principal);
    const req: Record<string, unknown> = {
      headers: {
        authorization: 'Bearer at',
        cookie: `${REFRESH_COOKIE}=rt`,
      },
    };
    await expect(guard.canActivate(contextFor(req))).resolves.toBe(true);
    expect(req.user).toBe(principal);
    expect(auth.refreshTokenOwner).not.toHaveBeenCalled();
  });

  it("falls back to the refresh cookie's owner", async () => {
    verifier.verify.mockRejectedValue(new AppError('AUTH_TOKEN_INVALID'));
    const req: Record<string, unknown> = {
      headers: {
        authorization: 'Bearer expired',
        cookie: `${REFRESH_COOKIE}=rt`,
      },
    };
    await guard.canActivate(contextFor(req));
    expect(req.user).toEqual({ tenantId: ACME, userId: 'owner-of-rt' });
  });

  it("uses the body token's owner for a native shell", async () => {
    const req: Record<string, unknown> = {
      headers: { origin: 'tauri://localhost', 'x-tropis-client': 'native' },
      body: { refreshToken: 'body-rt' },
    };
    await guard.canActivate(contextFor(req));
    expect(req.user).toEqual({ tenantId: ACME, userId: 'owner-of-body-rt' });
  });

  it('ignores a body token on the cookie endpoint and never rejects', async () => {
    const req: Record<string, unknown> = {
      headers: {},
      body: { refreshToken: 'body-rt' },
    };
    await expect(guard.canActivate(contextFor(req))).resolves.toBe(true);
    expect(req.user).toBeUndefined();
  });
});
