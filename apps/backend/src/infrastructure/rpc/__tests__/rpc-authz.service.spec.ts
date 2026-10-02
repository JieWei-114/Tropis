import { Code } from '@connectrpc/connect';
import {
  RpcAuthzService,
  bearerToken,
  rpcClientAddress,
} from '../rpc-authz.service';
import type { PolicyPort } from '../../policy/policy.port';
import { AuthorizationService } from '../../../common/authz/authorization.service';
import {
  bearer,
  rpcContextFor,
  rpcTestContext,
} from '../testing/rpc-test-context';
import {
  TEST_TENANT,
  signAccessToken,
  testTokenVerifier,
  type TestVerifier,
} from '../../../modules/auth/__tests__/token-fixtures';
import {
  UserRole,
  UserStatus,
} from '../../../modules/user/constants/user.enums';
import { TOKEN_REVOKED_KEY } from '../../../modules/auth/constants/auth.constants';

describe('RpcAuthzService', () => {
  let authz: RpcAuthzService;
  let opa: { allow: jest.Mock };
  let t: TestVerifier;

  const build = (
    status: UserStatus | null = UserStatus.ACTIVE,
    roles: UserRole[] = [UserRole.ADMIN],
  ) => {
    t = testTokenVerifier(status, roles);
    authz = new RpcAuthzService(
      t.verifier,
      new AuthorizationService(opa as unknown as PolicyPort),
    );
  };

  beforeEach(() => {
    opa = { allow: jest.fn().mockResolvedValue(true) };
    build();
  });

  it('reads the bearer token regardless of scheme case and whitespace', () => {
    expect(bearerToken(new Headers({ authorization: 'bearer  abc ' }))).toBe(
      'abc',
    );
    expect(bearerToken(new Headers({ authorization: 'Bearer ' }))).toBe(
      undefined,
    );
    expect(bearerToken(new Headers())).toBe(undefined);
  });

  it('rejects a missing token', async () => {
    const ctx = await rpcTestContext(authz);
    expect(() => authz.caller(ctx)).toThrow(
      expect.objectContaining({
        code: Code.Unauthenticated,
        rawMessage: 'Missing authorization token',
      }) as Error,
    );
  });

  it('rejects a token that does not verify', async () => {
    const forged = signAccessToken({}, {}, 'other-secret-other-secret-other');
    const ctx = await rpcTestContext(authz, bearer(forged));
    expect(() => authz.caller(ctx)).toThrow(
      expect.objectContaining({ code: Code.Unauthenticated }) as Error,
    );
  });

  // Reproduces the gap: RPC used to check only signature and expiry, so a
  // logged-out token and a suspended account kept working over RPC.
  it('rejects a revoked token', async () => {
    await t.kv.set(TOKEN_REVOKED_KEY.global('j1'), true, { ttlSeconds: 60 });
    const ctx = await rpcTestContext(
      authz,
      bearer(signAccessToken({ jti: 'j1' })),
    );
    expect(() => authz.caller(ctx)).toThrow(
      expect.objectContaining({
        code: Code.Unauthenticated,
        rawMessage: 'The access token has been revoked.',
      }) as Error,
    );
  });

  it('rejects the token of a suspended account', async () => {
    build(UserStatus.INACTIVE);
    const ctx = await rpcTestContext(authz, bearer(signAccessToken()));
    expect(() => authz.caller(ctx)).toThrow(
      expect.objectContaining({
        code: Code.Unauthenticated,
        rawMessage: 'The account is not active.',
      }) as Error,
    );
  });

  it('maps the verified principal', async () => {
    build(UserStatus.ACTIVE, [UserRole.EDITOR]);
    const token = signAccessToken({
      sub: 'u1',
      email: 'a@example.com',
      roles: ['editor'],
    });
    const ctx = await rpcTestContext(authz, bearer(token));
    expect(authz.caller(ctx)).toEqual({
      sub: 'u1',
      email: 'a@example.com',
      roles: ['editor'],
      tenantId: TEST_TENANT,
    });
  });

  it('asks the policy whether the caller may act, for handlers that branch on it', async () => {
    build(UserStatus.ACTIVE, [UserRole.VIEWER]);
    opa.allow.mockResolvedValue(false);
    const ctx = await rpcTestContext(
      authz,
      bearer(signAccessToken({ roles: ['viewer'] })),
    );
    await expect(
      authz.allows(authz.caller(ctx), 'user', 'delete'),
    ).resolves.toBe(false);
    expect(opa.allow).toHaveBeenCalledWith({
      roles: ['viewer'],
      resource: 'user',
      action: 'delete',
    });
  });

  // Reproduces the gap: the first X-Forwarded-For hop is whatever the client
  // sent, so rotating it defeated every per-address limit.
  it('takes the client address the trusted proxy appended (right-most hop)', () => {
    const at = (headers: Record<string, string>) =>
      rpcClientAddress(rpcContextFor({}, headers));
    expect(at({ 'x-forwarded-for': '1.1.1.1, 2.2.2.2, 10.0.0.7' })).toBe(
      '10.0.0.7',
    );
    expect(at({ 'x-forwarded-for': ' 10.0.0.7 ' })).toBe('10.0.0.7');
    expect(at({ 'x-real-ip': '1.1.1.1' })).toBe('unknown');
    expect(at({})).toBe('unknown');
  });

  it('clamps page sizes', () => {
    expect(RpcAuthzService.clampLimit(undefined, 20, 100)).toBe(20);
    expect(RpcAuthzService.clampLimit(0, 20, 100)).toBe(20);
    expect(RpcAuthzService.clampLimit(-5, 20, 100)).toBe(20);
    expect(RpcAuthzService.clampLimit(50, 20, 100)).toBe(50);
    expect(RpcAuthzService.clampLimit(5000, 20, 100)).toBe(100);
  });
});
