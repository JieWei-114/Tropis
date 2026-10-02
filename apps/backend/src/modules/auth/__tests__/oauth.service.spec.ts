import type { ConfigService } from '@nestjs/config';
import { createHash } from 'crypto';
import { AppError } from '../../../common/errors';
import { toTenantId } from '../../../common/keyspace';
import { InMemoryKvAdapter } from '../../../infrastructure/kv/__tests__/in-memory-kv.adapter';
import type { UserService } from '../../user/services/user.service';
import { UserStatus } from '../../user/constants/user.enums';
import type { AuthService } from '../services/auth.service';
import { OAuthService } from '../services/oauth.service';
import type { OAuthUserProfile } from '../interfaces/oauth-profile.interface';

const ACME = toTenantId('acme');

const profile: OAuthUserProfile = {
  provider: 'github',
  providerId: 'gh-1',
  email: 'new@example.com',
  name: 'New',
  emailVerified: true,
};

const VERIFIER = 'v'.repeat(43);
const CHALLENGE = createHash('sha256').update(VERIFIER).digest('base64url');

const account = (overrides = {}) => ({
  id: 'u1',
  name: 'New',
  email: 'new@example.com',
  status: UserStatus.ACTIVE,
  roles: ['member'],
  loginCount: 0,
  passwordHash: '',
  tenantId: 'acme',
  ...overrides,
});

describe('OAuthService', () => {
  let users: {
    findByProvider: jest.Mock;
    findByEmailWithPassword: jest.Mock;
    signUpWithProvider: jest.Mock;
    findByIdForAuth: jest.Mock;
  };
  let auth: { assertTenantActive: jest.Mock; issueTokenPair: jest.Mock };
  let kv: InMemoryKvAdapter;
  let service: OAuthService;

  beforeEach(() => {
    users = {
      findByProvider: jest.fn().mockResolvedValue(null),
      findByEmailWithPassword: jest.fn().mockResolvedValue(null),
      signUpWithProvider: jest.fn().mockResolvedValue(account()),
      findByIdForAuth: jest.fn().mockResolvedValue(account()),
    };
    auth = {
      assertTenantActive: jest.fn().mockResolvedValue(undefined),
      issueTokenPair: jest
        .fn()
        .mockResolvedValue({ accessToken: 'at', refreshToken: 'rt' }),
    };
    kv = new InMemoryKvAdapter();
    service = new OAuthService(
      users as unknown as UserService,
      auth as unknown as AuthService,
      { get: () => 'acme' } as unknown as ConfigService,
      kv,
    );
  });

  // Reproduces the gap: OAuth wrote new users straight through the
  // repository, so no user.created reached the outbox (search, vector and
  // graph never saw them) and the tenant's self sign-up rule was skipped.
  it('creates a new account through the provider sign-up path', async () => {
    await service.signIn(profile, '203.0.113.9', CHALLENGE, ACME);
    expect(users.signUpWithProvider).toHaveBeenCalledWith(
      ACME,
      {
        name: 'New',
        email: 'new@example.com',
        provider: 'github',
        providerId: 'gh-1',
      },
      '203.0.113.9',
    );
  });

  it('refuses to sign in to a tenant that is not active', async () => {
    auth.assertTenantActive.mockRejectedValue(
      Object.assign(new Error('inactive'), { code: 'TENANT_INACTIVE' }),
    );
    await expect(
      service.signIn(profile, 'ip', CHALLENGE, ACME),
    ).rejects.toMatchObject({
      code: 'TENANT_INACTIVE',
    });
    expect(users.signUpWithProvider).not.toHaveBeenCalled();
  });

  // Reproduces the gap: the callback put the access token in the redirect
  // query string, where it lands in history, logs and Referer headers.
  it('returns an opaque one-time code that trades once for a token pair', async () => {
    const code = await service.signIn(profile, 'ip', CHALLENGE, ACME);
    expect(code).not.toContain('.');
    expect(code.length).toBeGreaterThanOrEqual(40);

    await expect(service.exchange(code, VERIFIER)).resolves.toEqual({
      accessToken: 'at',
      refreshToken: 'rt',
    });
    expect(users.findByIdForAuth).toHaveBeenCalledWith(ACME, 'u1');
    await expect(service.exchange(code, VERIFIER)).rejects.toMatchObject({
      code: 'OAUTH_CODE_INVALID',
    });
  });

  it('rejects an unknown code', async () => {
    await expect(service.exchange('nope', VERIFIER)).rejects.toMatchObject({
      code: 'OAUTH_CODE_INVALID',
    });
  });

  it('refuses a code whose account was suspended in the meantime', async () => {
    const code = await service.signIn(profile, 'ip', CHALLENGE, ACME);
    users.findByIdForAuth.mockResolvedValue(
      account({ status: UserStatus.INACTIVE }),
    );
    await expect(service.exchange(code, VERIFIER)).rejects.toMatchObject({
      code: 'AUTH_ACCOUNT_INACTIVE',
    });
  });

  // Reproduces the login CSRF: the one-time code was not bound to the
  // browser that started the flow, so an attacker's code, planted in a
  // victim's browser, signed the victim into the attacker's account.
  it('trades a code only with the verifier of the challenge it was issued for', async () => {
    const code = await service.signIn(profile, 'ip', CHALLENGE, ACME);
    await expect(service.exchange(code, 'w'.repeat(43))).rejects.toMatchObject({
      code: 'OAUTH_CODE_INVALID',
    });
    // The code is spent by the failed attempt, so the verifier cannot be guessed.
    await expect(service.exchange(code, VERIFIER)).rejects.toMatchObject({
      code: 'OAUTH_CODE_INVALID',
    });
    expect(auth.issueTokenPair).not.toHaveBeenCalled();
  });

  it('rejects a missing or malformed verifier', async () => {
    const code = await service.signIn(profile, 'ip', CHALLENGE, ACME);
    await expect(service.exchange(code, '')).rejects.toMatchObject({
      code: 'OAUTH_CODE_INVALID',
    });
  });

  it('trades a native code only through a native exchange, and a web code only through a web one', async () => {
    const nativeCode = await service.signIn(
      profile,
      'ip',
      CHALLENGE,
      ACME,
      'native',
    );
    await expect(service.exchange(nativeCode, VERIFIER)).rejects.toMatchObject({
      code: 'OAUTH_CODE_INVALID',
    });
    const webCode = await service.signIn(profile, 'ip', CHALLENGE, ACME);
    await expect(
      service.exchange(webCode, VERIFIER, 'native'),
    ).rejects.toMatchObject({ code: 'OAUTH_CODE_INVALID' });

    const second = await service.signIn(
      profile,
      'ip',
      CHALLENGE,
      ACME,
      'native',
    );
    await expect(service.exchange(second, VERIFIER, 'native')).resolves.toEqual(
      { accessToken: 'at', refreshToken: 'rt' },
    );
  });

  describe('account linking', () => {
    // Reproduces the pre-hijack: an OAuth sign-in linked itself to any
    // existing account with the same email, so whoever registered that email
    // with a password first (or the provider account holder, later) got in.
    it('refuses to link to an account created with a password', async () => {
      users.findByEmailWithPassword.mockResolvedValue(
        account({ passwordHash: 'hash', provider: undefined }),
      );
      await expect(
        service.signIn(profile, 'ip', CHALLENGE, ACME),
      ).rejects.toMatchObject({ code: 'OAUTH_ACCOUNT_EXISTS' });
      expect(users.signUpWithProvider).not.toHaveBeenCalled();
    });

    it('refuses to link to an account created through another provider', async () => {
      users.findByEmailWithPassword.mockResolvedValue(
        account({ provider: 'google', providerId: 'g-9' }),
      );
      await expect(
        service.signIn(profile, 'ip', CHALLENGE, ACME),
      ).rejects.toMatchObject({ code: 'OAUTH_ACCOUNT_EXISTS' });
    });

    it('signs in to the account of the same provider and subject', async () => {
      users.findByProvider.mockResolvedValue(account());
      await expect(
        service.signIn(profile, 'ip', CHALLENGE, ACME),
      ).resolves.toEqual(expect.any(String));
      expect(users.findByProvider).toHaveBeenCalledWith(ACME, 'github', 'gh-1');
      expect(users.signUpWithProvider).not.toHaveBeenCalled();
    });

    it('reports a sign-up that lost the email race as OAUTH_ACCOUNT_EXISTS', async () => {
      users.signUpWithProvider.mockRejectedValue(
        new AppError('USER_ALREADY_EXISTS'),
      );
      await expect(
        service.signIn(profile, 'ip', CHALLENGE, ACME),
      ).rejects.toMatchObject({ code: 'OAUTH_ACCOUNT_EXISTS' });
    });
  });
});
