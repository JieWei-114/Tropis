import { Test, TestingModule } from '@nestjs/testing';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import * as bcrypt from 'bcrypt';
import { createHash, createHmac } from 'crypto';
import { toTenantId } from '../../../common/keyspace';
import { InMemoryKvAdapter } from '../../../infrastructure/kv/__tests__/in-memory-kv.adapter';
import { KV } from '../../../infrastructure/kv/kv.port';
import { AuthService } from '../services/auth.service';
import { UserStatus } from '../../user/constants/user.enums';
import { UserService } from '../../user/services/user.service';
import { LoginLockoutService } from '../services/login-lockout.service';
import { SessionService } from '../services/session.service';
import {
  REFRESH_TOKEN_KEY,
  TOKEN_REVOKED_KEY,
} from '../constants/auth.constants';
import { TENANT_DIRECTORY } from '../../../common/tenant/tenant-directory.port';
import { activeTenant } from './token-fixtures';

const TEST_SECRET = 'test-jwt-secret-at-least-32-characters!!';
const TENANT = toTenantId('initech');
const OTHER_TENANT = toTenantId('acme');

const refreshKeyFor = (tenant: string, userId: string, tokenId: string) =>
  REFRESH_TOKEN_KEY.forTenant(
    toTenantId(tenant),
    userId,
    createHash('sha256').update(tokenId).digest('hex'),
  );

describe('AuthService', () => {
  let service: AuthService;
  let userService: jest.Mocked<
    Pick<
      UserService,
      'findByEmailWithPassword' | 'recordLogin' | 'findByIdForAuth'
    >
  >;
  let jwtService: jest.Mocked<Pick<JwtService, 'sign'>>;
  let kv: InMemoryKvAdapter;
  let lockout: {
    assertNotLocked: jest.Mock;
    recordFailure: jest.Mock;
    reset: jest.Mock;
  };
  let sessions: SessionService;
  let tenants: { find: jest.Mock };

  const mockUserWithPassword = {
    id: 'user-123',
    email: 'alice@example.com',
    passwordHash: '', // set per test via bcrypt.hash
    status: UserStatus.ACTIVE,
    tenantId: 'initech',
  };

  // Mirror AuthService: HMAC-sign the token so decodeRefreshToken accepts it.
  const encodeRefreshToken = (
    userId: string,
    tokenId: string,
    tenantId = 'initech',
  ) => {
    const sig = createHmac('sha256', TEST_SECRET)
      .update(`${tenantId}\n${userId}\n${tokenId}`)
      .digest('hex');
    return Buffer.from(
      JSON.stringify({ tenantId, userId, tokenId, sig }),
    ).toString('base64url');
  };

  /** Stores a live refresh token, as createRefreshToken would. */
  const storeRefreshToken = (
    userId: string,
    tokenId: string,
    tenant = 'initech',
  ) => kv.set(refreshKeyFor(tenant, userId, tokenId), true, { ttlSeconds: 60 });

  beforeEach(async () => {
    userService = {
      findByEmailWithPassword: jest.fn(),
      recordLogin: jest.fn().mockResolvedValue(undefined),
      findByIdForAuth: jest.fn(),
    };

    jwtService = {
      sign: jest.fn().mockReturnValue('signed.jwt.token'),
    };

    kv = new InMemoryKvAdapter();

    lockout = {
      assertNotLocked: jest.fn().mockResolvedValue(undefined),
      recordFailure: jest.fn().mockResolvedValue(undefined),
      reset: jest.fn().mockResolvedValue(undefined),
    };

    // Real instance over the same in-memory kv.
    sessions = new SessionService(kv);
    tenants = { find: jest.fn().mockResolvedValue(activeTenant()) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: UserService, useValue: userService },
        { provide: JwtService, useValue: jwtService },
        { provide: ConfigService, useValue: { getOrThrow: () => TEST_SECRET } },
        { provide: KV, useValue: kv },
        { provide: LoginLockoutService, useValue: lockout },
        { provide: SessionService, useValue: sessions },
        { provide: TENANT_DIRECTORY, useValue: tenants },
      ],
    }).compile();

    service = module.get(AuthService);
  });

  describe('login', () => {
    it('throws UnauthorizedException when email is not found', async () => {
      userService.findByEmailWithPassword.mockResolvedValue(null);

      await expect(
        service.login(TENANT, {
          email: 'unknown@example.com',
          password: 'pass',
        }),
      ).rejects.toMatchObject({ status: 401 });
    });

    // Reproduces the tenant enumeration: an anonymous login answered
    // TENANT_NOT_FOUND or TENANT_INACTIVE, telling a caller which tenant ids
    // exist and which are suspended.
    it.each([
      ['not registered', null],
      ['suspended', activeTenant({ status: 'suspended' })],
    ])(
      'answers AUTH_INVALID_CREDENTIALS when the tenant is %s',
      async (_label, record) => {
        tenants.find.mockResolvedValue(record);
        await expect(
          service.login(TENANT, {
            email: 'alice@example.com',
            password: 'secret123',
          }),
        ).rejects.toMatchObject({ code: 'AUTH_INVALID_CREDENTIALS' });
        expect(userService.findByEmailWithPassword).not.toHaveBeenCalled();
      },
    );

    it('signs the account token version into the access token', async () => {
      const hash = await bcrypt.hash('secret123', 10);
      userService.findByEmailWithPassword.mockResolvedValue({
        ...mockUserWithPassword,
        passwordHash: hash,
        tokenVersion: 4,
      } as never);
      await service.login(TENANT, {
        email: 'alice@example.com',
        password: 'secret123',
      });
      expect(jwtService.sign).toHaveBeenCalledWith(
        expect.objectContaining({ tv: 4 }),
      );
    });

    it('refuses to issue a token for an account that is not active', async () => {
      // status is an access-control field: issuing a token for a non-active
      // account gives a suspended user full access, including the ability to
      // reactivate itself.
      const hash = await bcrypt.hash('correct', 10);
      userService.findByEmailWithPassword.mockResolvedValue({
        ...mockUserWithPassword,
        passwordHash: hash,
        status: UserStatus.INACTIVE,
      } as never);

      await expect(
        service.login(TENANT, {
          email: 'alice@example.com',
          password: 'correct',
        }),
      ).rejects.toMatchObject({ status: 401 });
    });

    it('throws UnauthorizedException when password is wrong', async () => {
      const hash = await bcrypt.hash('correct', 10);
      userService.findByEmailWithPassword.mockResolvedValue({
        ...mockUserWithPassword,
        passwordHash: hash,
      } as any);

      await expect(
        service.login(TENANT, {
          email: 'alice@example.com',
          password: 'wrong',
        }),
      ).rejects.toMatchObject({ status: 401 });
    });

    it('returns access + refresh token pair on valid credentials', async () => {
      const hash = await bcrypt.hash('secret123', 10);
      userService.findByEmailWithPassword.mockResolvedValue({
        ...mockUserWithPassword,
        passwordHash: hash,
      } as any);

      const result = await service.login(TENANT, {
        email: 'alice@example.com',
        password: 'secret123',
      });

      expect(result.accessToken).toBe('signed.jwt.token');
      expect(typeof result.refreshToken).toBe('string');
      expect(jwtService.sign).toHaveBeenCalledWith(
        expect.objectContaining({
          sub: 'user-123',
          email: 'alice@example.com',
          roles: [],
          tenantId: expect.any(String),
          jti: expect.any(String),
        }),
      );
      // refresh token persisted in kv, tenant-scoped, with a TTL
      const { tenantId, userId, tokenId } = JSON.parse(
        Buffer.from(result.refreshToken, 'base64url').toString('utf8'),
      ) as { tenantId: string; userId: string; tokenId: string };
      expect({ tenantId, userId }).toEqual({
        tenantId: 'initech',
        userId: 'user-123',
      });
      await expect(
        kv.exists(refreshKeyFor(tenantId, userId, tokenId)),
      ).resolves.toBe(true);
    });

    it('records a session on successful login (fire-and-forget)', async () => {
      const createSpy = jest.spyOn(sessions, 'create');
      const hash = await bcrypt.hash('secret123', 10);
      userService.findByEmailWithPassword.mockResolvedValue({
        ...mockUserWithPassword,
        passwordHash: hash,
      } as any);

      await service.login(
        TENANT,
        { email: 'alice@example.com', password: 'secret123' },
        '10.0.0.1',
      );

      expect(createSpy).toHaveBeenCalledWith(
        TENANT,
        'user-123',
        'alice@example.com',
        '10.0.0.1',
      );
    });

    it('fires recordLogin after successful login (non-blocking)', async () => {
      const hash = await bcrypt.hash('secret123', 10);
      userService.findByEmailWithPassword.mockResolvedValue({
        ...mockUserWithPassword,
        passwordHash: hash,
      } as any);

      await service.login(TENANT, {
        email: 'alice@example.com',
        password: 'secret123',
      });

      expect(userService.recordLogin).toHaveBeenCalledWith(TENANT, 'user-123');
    });

    it('checks lockout before password verification and rejects when locked', async () => {
      lockout.assertNotLocked.mockRejectedValue(new Error('locked'));

      await expect(
        service.login(
          TENANT,
          { email: 'alice@example.com', password: 'secret123' },
          '1.2.3.4',
        ),
      ).rejects.toThrow('locked');
      expect(userService.findByEmailWithPassword).not.toHaveBeenCalled();
    });

    it('records a lockout failure on wrong password', async () => {
      const hash = await bcrypt.hash('correct', 10);
      userService.findByEmailWithPassword.mockResolvedValue({
        ...mockUserWithPassword,
        passwordHash: hash,
      } as any);

      await expect(
        service.login(
          TENANT,
          { email: 'alice@example.com', password: 'wrong' },
          '1.2.3.4',
        ),
      ).rejects.toMatchObject({ status: 401 });
      expect(lockout.recordFailure).toHaveBeenCalledWith(
        TENANT,
        'alice@example.com',
        '1.2.3.4',
      );
    });

    it('resets the lockout counter on successful login', async () => {
      const hash = await bcrypt.hash('secret123', 10);
      userService.findByEmailWithPassword.mockResolvedValue({
        ...mockUserWithPassword,
        passwordHash: hash,
      } as any);

      await service.login(
        TENANT,
        { email: 'alice@example.com', password: 'secret123' },
        '1.2.3.4',
      );

      expect(lockout.reset).toHaveBeenCalledWith(
        TENANT,
        'alice@example.com',
        '1.2.3.4',
      );
      expect(lockout.recordFailure).not.toHaveBeenCalled();
    });
  });

  describe('logout / isBlacklisted', () => {
    it('blacklists the access token jti until the token expiry', async () => {
      const exp = Math.floor(Date.now() / 1000) + 60;

      const set = jest.spyOn(kv, 'set');

      await service.logout('jti-1', exp);

      expect(set).toHaveBeenCalledWith(
        TOKEN_REVOKED_KEY.global('jti-1'),
        true,
        {
          ttlSeconds: expect.any(Number) as number,
        },
      );
      const ttl = (set.mock.calls[0][2] as { ttlSeconds: number }).ttlSeconds;
      expect(ttl).toBeGreaterThanOrEqual(59);
      expect(ttl).toBeLessThanOrEqual(60);
      await expect(service.isBlacklisted('jti-1')).resolves.toBe(true);
    });

    it('does not blacklist an already-expired token', async () => {
      const exp = Math.floor(Date.now() / 1000) - 60;
      const set = jest.spyOn(kv, 'set');

      await service.logout('jti-1', exp);

      expect(set).not.toHaveBeenCalled();
    });

    it('deletes the paired refresh token on logout', async () => {
      const exp = Math.floor(Date.now() / 1000) + 60;
      await storeRefreshToken('user-123', 'tok-1');

      await service.logout(
        'jti-1',
        exp,
        encodeRefreshToken('user-123', 'tok-1'),
      );

      // key stores a hash of the tokenId, not the raw id
      await expect(
        kv.exists(refreshKeyFor('initech', 'user-123', 'tok-1')),
      ).resolves.toBe(false);
      expect(refreshKeyFor('initech', 'user-123', 'tok-1')).toMatch(
        /:user-123:[0-9a-f]{64}$/,
      );
    });

    it('invalidates the session on logout', async () => {
      const invalidateSpy = jest.spyOn(sessions, 'invalidate');
      const exp = Math.floor(Date.now() / 1000) + 60;

      await service.logout(
        'jti-1',
        exp,
        encodeRefreshToken('user-123', 'tok-1'),
      );

      expect(invalidateSpy).toHaveBeenCalledWith(TENANT, 'user-123');
    });

    it('isBlacklisted returns true when the jti key exists', async () => {
      await kv.set(TOKEN_REVOKED_KEY.global('jti-1'), true, { ttlSeconds: 60 });
      await expect(service.isBlacklisted('jti-1')).resolves.toBe(true);
    });

    it('isBlacklisted returns false when the jti key is absent', async () => {
      await expect(service.isBlacklisted('jti-1')).resolves.toBe(false);
    });
  });

  describe('refresh', () => {
    it('throws UnauthorizedException for a malformed refresh token', async () => {
      await expect(service.refresh('not-base64-json')).rejects.toMatchObject({
        status: 401,
      });
    });

    it('throws UnauthorizedException when the refresh token is revoked', async () => {
      await expect(
        service.refresh(encodeRefreshToken('user-123', 'tok-1')),
      ).rejects.toMatchObject({ status: 401 });
    });

    it('rejects a forged/tampered refresh token before any store lookup', async () => {
      await storeRefreshToken('victim', 'guess'); // the store would say "valid" if reached
      const del = jest.spyOn(kv, 'del');
      // Attacker fabricates {tenantId, userId, tokenId} with a bogus signature.
      const forged = Buffer.from(
        JSON.stringify({
          tenantId: 'initech',
          userId: 'victim',
          tokenId: 'guess',
          sig: 'deadbeef',
        }),
      ).toString('base64url');

      await expect(service.refresh(forged)).rejects.toMatchObject({
        status: 401,
      });
      expect(del).not.toHaveBeenCalled(); // rejected on signature, pre-lookup
    });

    it('rejects a refresh token re-signed for another tenant', async () => {
      await storeRefreshToken('user-123', 'tok-1', 'initech');
      // Same user and token id, tenant swapped: the HMAC covers the tenant.
      const swapped = JSON.parse(
        Buffer.from(
          encodeRefreshToken('user-123', 'tok-1'),
          'base64url',
        ).toString('utf8'),
      ) as Record<string, string>;
      const tampered = Buffer.from(
        JSON.stringify({ ...swapped, tenantId: OTHER_TENANT }),
      ).toString('base64url');

      await expect(service.refresh(tampered)).rejects.toMatchObject({
        status: 401,
      });
    });

    it('rotates the token and issues a new pair', async () => {
      await storeRefreshToken('user-123', 'tok-1');
      userService.findByIdForAuth.mockResolvedValue({
        id: 'user-123',
        email: 'alice@example.com',
        passwordHash: 'x',
        status: UserStatus.ACTIVE,
        tenantId: 'initech',
      } as any);

      const result = await service.refresh(
        encodeRefreshToken('user-123', 'tok-1'),
      );

      await expect(
        kv.exists(refreshKeyFor('initech', 'user-123', 'tok-1')),
      ).resolves.toBe(false);
      expect(userService.findByIdForAuth).toHaveBeenCalledWith(
        TENANT,
        'user-123',
      );
      expect(result.accessToken).toBe('signed.jwt.token');
      expect(typeof result.refreshToken).toBe('string');
    });

    it('lets only one of two concurrent refreshes of the same token succeed', async () => {
      await storeRefreshToken('user-123', 'tok-1');
      userService.findByIdForAuth.mockResolvedValue({
        id: 'user-123',
        email: 'alice@example.com',
        passwordHash: 'x',
        status: UserStatus.ACTIVE,
        tenantId: 'initech',
      } as any);
      const token = encodeRefreshToken('user-123', 'tok-1');

      const results = await Promise.allSettled([
        service.refresh(token),
        service.refresh(token),
      ]);

      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    });

    it('re-creates the session on refresh rotation', async () => {
      const createSpy = jest.spyOn(sessions, 'create');
      await storeRefreshToken('user-123', 'tok-1');
      userService.findByIdForAuth.mockResolvedValue({
        id: 'user-123',
        email: 'alice@example.com',
        passwordHash: 'x',
        status: UserStatus.ACTIVE,
        tenantId: 'initech',
      } as any);

      await service.refresh(encodeRefreshToken('user-123', 'tok-1'));

      expect(createSpy).toHaveBeenCalledWith(
        TENANT,
        'user-123',
        'alice@example.com',
      );
    });

    // Reproduces the suspension bypass: refresh never checked the account
    // status, so a suspended user could keep rotating refresh tokens and
    // minting access tokens.
    it('refuses to refresh an account that is no longer active', async () => {
      await storeRefreshToken('user-123', 'tok-1');
      userService.findByIdForAuth.mockResolvedValue({
        id: 'user-123',
        email: 'alice@example.com',
        passwordHash: 'x',
        status: UserStatus.INACTIVE,
        tenantId: 'initech',
      } as any);

      await expect(
        service.refresh(encodeRefreshToken('user-123', 'tok-1')),
      ).rejects.toMatchObject({ code: 'AUTH_ACCOUNT_INACTIVE' });
      expect(jwtService.sign).not.toHaveBeenCalled();
    });

    // Reproduces the gap: a password change left every refresh token valid,
    // so a stolen session survived the change.
    it('refuses a refresh token issued before the token version was bumped', async () => {
      const hash = await bcrypt.hash('secret123', 10);
      userService.findByEmailWithPassword.mockResolvedValue({
        ...mockUserWithPassword,
        passwordHash: hash,
        tokenVersion: 0,
      } as never);
      const { refreshToken } = await service.login(TENANT, {
        email: 'alice@example.com',
        password: 'secret123',
      });
      userService.findByIdForAuth.mockResolvedValue({
        ...mockUserWithPassword,
        tokenVersion: 1,
      } as never);
      jwtService.sign.mockClear();

      await expect(service.refresh(refreshToken)).rejects.toMatchObject({
        code: 'AUTH_TOKEN_REVOKED',
      });
      expect(jwtService.sign).not.toHaveBeenCalled();
    });

    it('throws UnauthorizedException when the user no longer exists', async () => {
      await storeRefreshToken('user-123', 'tok-1');
      userService.findByIdForAuth.mockResolvedValue(null);

      await expect(
        service.refresh(encodeRefreshToken('user-123', 'tok-1')),
      ).rejects.toMatchObject({ status: 401 });
    });
  });
});
