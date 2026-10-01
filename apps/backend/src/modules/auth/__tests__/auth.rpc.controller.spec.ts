import { JwtService } from '@nestjs/jwt';
import { Code } from '@connectrpc/connect';
import * as bcrypt from 'bcrypt';
import * as jwt from 'jsonwebtoken';
import { toTenantId } from '../../../common/keyspace';
import {
  runInTenant,
  TenantContext,
} from '../../../common/tenant/tenant.context';
import { InMemoryKvAdapter } from '../../../infrastructure/kv/__tests__/in-memory-kv.adapter';
import { InMemoryRateLimitAdapter } from '../../../infrastructure/ratelimit/__tests__/in-memory-ratelimit.adapter';
import { AuthRpcController } from '../controllers/auth.rpc.controller';
import { AuthService } from '../services/auth.service';
import {
  LOCKOUT_MAX_ATTEMPTS,
  LoginLockoutService,
} from '../services/login-lockout.service';
import { SessionService } from '../services/session.service';
import { UserService } from '../../user/services/user.service';
import { UserStatus } from '../../user/constants/user.enums';
import { RpcAuthzService } from '../../../infrastructure/rpc/rpc-authz.service';
import {
  bearer,
  rpcContextFor,
  rpcTestContext,
} from '../../../infrastructure/rpc/testing/rpc-test-context';
import type { TenantDirectory } from '../../../common/tenant/tenant-directory.port';
import {
  TEST_JWT_SECRET,
  activeTenant,
  signAccessToken,
  testConfig,
  testTokenVerifier,
} from './token-fixtures';

const ACME = toTenantId('acme');

const errorCode = (p: Promise<unknown>) =>
  p.then(
    () => 'resolved',
    (e: { code?: unknown }) => e.code,
  );

describe('AuthRpcController', () => {
  let controller: AuthRpcController;
  let authz: RpcAuthzService;
  let userService: {
    findByEmailWithPassword: jest.Mock;
    recordLogin: jest.Mock;
  };
  let rateLimit: InMemoryRateLimitAdapter;
  let tenants: { find: jest.Mock };
  let passwordHash: string;

  const ctx = rpcContextFor({}, { 'x-forwarded-for': '10.0.0.1' });
  const login = (email: string, password: string, tenant = ACME) =>
    runInTenant(tenant, () =>
      controller.login({ email, password } as never, ctx),
    );

  beforeAll(async () => {
    passwordHash = await bcrypt.hash('password1', 4);
  });

  beforeEach(() => {
    tenants = { find: jest.fn().mockResolvedValue(activeTenant()) };
    const kv = new InMemoryKvAdapter();
    userService = {
      findByEmailWithPassword: jest.fn().mockResolvedValue(null),
      recordLogin: jest.fn().mockResolvedValue(undefined),
    };
    rateLimit = new InMemoryRateLimitAdapter();
    const lockout = new LoginLockoutService(rateLimit, kv);
    const auth = new AuthService(
      userService as unknown as UserService,
      new JwtService({
        secret: TEST_JWT_SECRET,
        signOptions: { expiresIn: '15m' },
      }),
      testConfig(),
      kv,
      lockout,
      new SessionService(kv),
      tenants as unknown as TenantDirectory,
    );
    authz = new RpcAuthzService(testTokenVerifier().verifier, {} as never);
    controller = new AuthRpcController(
      auth,
      lockout,
      authz,
      new TenantContext(),
    );
  });

  const activeUser = (overrides: Record<string, unknown> = {}) => ({
    id: 'u1',
    email: 'a@example.com',
    roles: ['editor'],
    tenantId: 'acme',
    status: UserStatus.ACTIVE,
    passwordHash,
    ...overrides,
  });

  it('requires a tenant', async () => {
    await expect(
      errorCode(controller.login({ email: 'a', password: 'b' } as never, ctx)),
    ).resolves.toBe('TENANT_REQUIRED');
  });

  it.each([
    ['', ''],
    ['', 'password1'],
    ['a@example.com', ''],
  ])(
    'rejects blank credentials (%p, %p) as invalid',
    async (email, password) => {
      await expect(errorCode(login(email, password))).resolves.toBe(
        'AUTH_INVALID_CREDENTIALS',
      );
      expect(userService.findByEmailWithPassword).not.toHaveBeenCalled();
    },
  );

  it('issues a revocable token carrying the user, roles and tenant', async () => {
    userService.findByEmailWithPassword.mockResolvedValue(activeUser());

    const res = await login('a@example.com', 'password1');

    const claims = jwt.verify(
      res.accessToken as string,
      TEST_JWT_SECRET,
    ) as Record<string, unknown>;
    expect(claims).toMatchObject({
      sub: 'u1',
      email: 'a@example.com',
      roles: ['editor'],
      tenantId: 'acme',
    });
    expect(typeof claims.jti).toBe('string');
    expect(userService.findByEmailWithPassword).toHaveBeenCalledWith(
      ACME,
      'a@example.com',
    );
    expect(userService.recordLogin).toHaveBeenCalledWith(ACME, 'u1');
  });

  // One answer for every reason, so an anonymous caller cannot tell which
  // tenant ids exist.
  it.each([
    [null, 'AUTH_INVALID_CREDENTIALS'],
    [activeTenant({ status: 'suspended' }), 'AUTH_INVALID_CREDENTIALS'],
  ])(
    'refuses a login in a tenant that is not active (%p)',
    async (tenant, expected) => {
      tenants.find.mockResolvedValue(tenant);
      userService.findByEmailWithPassword.mockResolvedValue(activeUser());
      await expect(
        errorCode(login('a@example.com', 'password1')),
      ).resolves.toBe(expected);
    },
  );

  it('rejects a wrong password', async () => {
    userService.findByEmailWithPassword.mockResolvedValue(activeUser());
    await expect(errorCode(login('a@example.com', 'wrong'))).resolves.toBe(
      'AUTH_INVALID_CREDENTIALS',
    );
  });

  // Reproduces the gap: RPC login skipped the account status check, so a
  // suspended account could still obtain a token over RPC.
  it('rejects an inactive account', async () => {
    userService.findByEmailWithPassword.mockResolvedValue(
      activeUser({ status: UserStatus.INACTIVE }),
    );
    await expect(errorCode(login('a@example.com', 'password1'))).resolves.toBe(
      'AUTH_ACCOUNT_INACTIVE',
    );
  });

  // Reproduces the gap: RPC login skipped the failed-attempt lockout.
  it('locks the account after repeated failures, even with the right password', async () => {
    userService.findByEmailWithPassword.mockResolvedValue(activeUser());
    for (let i = 0; i < LOCKOUT_MAX_ATTEMPTS; i++) {
      await login('a@example.com', 'wrong').catch(() => undefined);
    }
    await expect(errorCode(login('a@example.com', 'password1'))).resolves.toBe(
      'AUTH_LOGIN_LOCKED',
    );
  });

  it('keeps lockouts per tenant', async () => {
    userService.findByEmailWithPassword.mockResolvedValue(activeUser());
    for (let i = 0; i < LOCKOUT_MAX_ATTEMPTS; i++) {
      await login('a@example.com', 'wrong').catch(() => undefined);
    }
    await expect(
      login('a@example.com', 'password1', toTenantId('globex')),
    ).resolves.toHaveProperty('accessToken');
  });

  describe('login rate limit', () => {
    it('rejects the 11th attempt in the window before checking credentials', async () => {
      for (let i = 0; i < 10; i++) {
        await login('same@example.com', 'x').catch(() => undefined);
      }
      userService.findByEmailWithPassword.mockClear();
      await expect(errorCode(login('same@example.com', 'x'))).resolves.toBe(
        'RATE_LIMITED',
      );
      expect(userService.findByEmailWithPassword).not.toHaveBeenCalled();
    });

    it('fails open when the ratelimit store is down', async () => {
      jest.spyOn(rateLimit, 'hit').mockRejectedValue(new Error('down'));
      await expect(errorCode(login('a@example.com', 'x'))).resolves.toBe(
        'AUTH_INVALID_CREDENTIALS',
      );
    });
  });

  describe('getCurrentUser', () => {
    it('echoes the verified subject', async () => {
      const token = signAccessToken({ sub: 'u1', email: 'a@example.com' });
      expect(
        controller.getCurrentUser(
          {} as never,
          await rpcTestContext(authz, bearer(token)),
        ),
      ).toEqual({ userId: 'u1', email: 'a@example.com' });
    });

    it.each([
      ['missing', {}],
      ['invalid', bearer('garbage')],
    ])('answers a %s token with UNAUTHENTICATED', async (_n, headers) => {
      const context = await rpcTestContext(authz, headers);
      expect(() => controller.getCurrentUser({} as never, context)).toThrow(
        expect.objectContaining({ code: Code.Unauthenticated }),
      );
    });
  });
});
