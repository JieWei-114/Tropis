import { toTenantId } from '../../../common/keyspace';
import { UserRole, UserStatus } from '../../user/constants/user.enums';
import { ACCOUNT_SUSPENDED_KEY } from '../../user/constants/user.constants';
import { TOKEN_REVOKED_KEY } from '../constants/auth.constants';
import {
  TEST_TENANT,
  activeTenant,
  signAccessToken,
  testTokenVerifier,
} from './token-fixtures';

const code = (p: Promise<unknown>) =>
  p.then(
    () => 'resolved',
    (e: { code?: string }) => e.code,
  );

describe('TokenVerifierService', () => {
  it('returns the principal of a valid token', async () => {
    const { verifier, members } = testTokenVerifier();
    const principal = await verifier.verify(signAccessToken({ jti: 'j1' }));
    expect(principal).toMatchObject({
      userId: 'user-1',
      email: 'alice@example.com',
      roles: ['admin'],
      tenantId: TEST_TENANT,
      jti: 'j1',
    });
    expect(members.findMember).toHaveBeenCalledWith(TEST_TENANT, 'user-1');
  });

  it('rejects a forged, expired or incomplete token', async () => {
    const { verifier } = testTokenVerifier();
    await expect(
      code(
        verifier.verify(
          signAccessToken({}, {}, 'another-secret-another-secret'),
        ),
      ),
    ).resolves.toBe('AUTH_TOKEN_INVALID');
    await expect(
      code(verifier.verify(signAccessToken({}, { expiresIn: -10 }))),
    ).resolves.toBe('AUTH_TOKEN_INVALID');
    await expect(
      code(verifier.verify(signAccessToken({ tenantId: undefined }))),
    ).resolves.toBe('AUTH_TOKEN_INVALID');
    await expect(
      code(verifier.verify(signAccessToken({ jti: undefined }))),
    ).resolves.toBe('AUTH_TOKEN_INVALID');
  });

  // Reproduces the gap: a password change, email change, role change or
  // suspension left every token issued before it working until expiry.
  it('rejects a token issued before the account token version was bumped', async () => {
    const { verifier, members } = testTokenVerifier();
    members.findMember.mockResolvedValue({
      status: UserStatus.ACTIVE,
      roles: [UserRole.ADMIN],
      tokenVersion: 3,
    });
    await expect(
      code(verifier.verify(signAccessToken({ tv: 2 }))),
    ).resolves.toBe('AUTH_TOKEN_REVOKED');
    await expect(
      code(verifier.verify(signAccessToken({ tv: 3 }))),
    ).resolves.toBe('resolved');
  });

  it('treats a token without a version as version 0', async () => {
    const { verifier, members } = testTokenVerifier();
    members.findMember.mockResolvedValue({
      status: UserStatus.ACTIVE,
      roles: [UserRole.ADMIN],
      tokenVersion: 1,
    });
    await expect(code(verifier.verify(signAccessToken()))).resolves.toBe(
      'AUTH_TOKEN_REVOKED',
    );
  });

  it('rejects a revoked token', async () => {
    const { verifier, kv } = testTokenVerifier();
    await kv.set(TOKEN_REVOKED_KEY.global('j1'), true, { ttlSeconds: 60 });
    await expect(
      code(verifier.verify(signAccessToken({ jti: 'j1' }))),
    ).resolves.toBe('AUTH_TOKEN_REVOKED');
  });

  it('rejects the token of a suspended account (record status)', async () => {
    const { verifier } = testTokenVerifier(UserStatus.INACTIVE);
    await expect(code(verifier.verify(signAccessToken()))).resolves.toBe(
      'AUTH_ACCOUNT_INACTIVE',
    );
  });

  it('rejects the token of a suspended account (suspension marker)', async () => {
    const { verifier, kv } = testTokenVerifier();
    await kv.set(
      ACCOUNT_SUSPENDED_KEY.forTenant(toTenantId(TEST_TENANT), 'user-1'),
      'inactive',
      { ttlSeconds: 60 },
    );
    await expect(code(verifier.verify(signAccessToken()))).resolves.toBe(
      'AUTH_ACCOUNT_INACTIVE',
    );
  });

  it('rejects a token whose user is not a member of the tenant', async () => {
    const { verifier } = testTokenVerifier(null);
    await expect(code(verifier.verify(signAccessToken()))).resolves.toBe(
      'AUTH_TOKEN_INVALID',
    );
  });

  it('takes roles from the member record, not the token, so a demotion applies at once', async () => {
    const { verifier } = testTokenVerifier(UserStatus.ACTIVE, [
      UserRole.MEMBER,
    ]);
    const principal = await verifier.verify(
      signAccessToken({ roles: ['admin'] }),
    );
    expect(principal.roles).toEqual(['member']);
  });

  it('rejects a token whose tenant is suspended', async () => {
    const { verifier } = testTokenVerifier(
      UserStatus.ACTIVE,
      [UserRole.ADMIN],
      activeTenant({ status: 'suspended' }),
    );
    await expect(code(verifier.verify(signAccessToken()))).resolves.toBe(
      'TENANT_INACTIVE',
    );
  });

  it('rejects a token whose tenant is not registered', async () => {
    const { verifier } = testTokenVerifier(
      UserStatus.ACTIVE,
      [UserRole.ADMIN],
      null,
    );
    await expect(code(verifier.verify(signAccessToken()))).resolves.toBe(
      'AUTH_TOKEN_INVALID',
    );
  });

  it('fails closed when a store is unreachable', async () => {
    const { verifier, kv } = testTokenVerifier();
    jest.spyOn(kv, 'exists').mockRejectedValue(new Error('down'));
    await expect(code(verifier.verify(signAccessToken()))).resolves.toBe(
      'SERVICE_UNAVAILABLE',
    );
  });
});
