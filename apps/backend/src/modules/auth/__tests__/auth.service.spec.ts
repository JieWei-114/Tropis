import { Test, TestingModule } from '@nestjs/testing';
import { UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import * as bcrypt from 'bcrypt';
import { createHmac } from 'crypto';
import { AuthService } from '../services/auth.service';
import { UserStatus } from '../../user/constants/user.enums';
import { UserService } from '../../user/services/user.service';
import { REDIS_CLIENT } from '../../../infrastructure/redis/redis.module';
import { LoginLockoutService } from '../services/login-lockout.service';
import { SessionService } from '../../../infrastructure/aerospike/session.service';

const TEST_SECRET = 'test-jwt-secret-at-least-32-characters!!';

describe('AuthService', () => {
  let service: AuthService;
  let userService: jest.Mocked<
    Pick<
      UserService,
      'findByEmailWithPassword' | 'recordLogin' | 'findByIdForAuth'
    >
  >;
  let jwtService: jest.Mocked<Pick<JwtService, 'sign'>>;
  let redis: { set: jest.Mock; del: jest.Mock; exists: jest.Mock };
  let lockout: {
    assertNotLocked: jest.Mock;
    recordFailure: jest.Mock;
    reset: jest.Mock;
  };
  let sessions: SessionService;

  const mockUserWithPassword = {
    id: 'user-123',
    email: 'alice@example.com',
    passwordHash: '', // set per test via bcrypt.hash
    status: UserStatus.ACTIVE,
  };

  // Mirror AuthService: HMAC-sign the token so decodeRefreshToken accepts it.
  const encodeRefreshToken = (userId: string, tokenId: string) => {
    const sig = createHmac('sha256', TEST_SECRET)
      .update(`${userId}:${tokenId}`)
      .digest('hex');
    return Buffer.from(JSON.stringify({ userId, tokenId, sig })).toString(
      'base64url',
    );
  };

  beforeEach(async () => {
    userService = {
      findByEmailWithPassword: jest.fn(),
      recordLogin: jest.fn().mockResolvedValue(undefined),
      findByIdForAuth: jest.fn(),
    };

    jwtService = {
      sign: jest.fn().mockReturnValue('signed.jwt.token'),
    };

    redis = {
      set: jest.fn().mockResolvedValue('OK'),
      del: jest.fn().mockResolvedValue(1),
      exists: jest.fn().mockResolvedValue(0),
    };

    lockout = {
      assertNotLocked: jest.fn().mockResolvedValue(undefined),
      recordFailure: jest.fn().mockResolvedValue(undefined),
      reset: jest.fn().mockResolvedValue(undefined),
    };

    // Real instance with a null Aerospike client — every method is a no-op,
    // mirroring the degraded mode used in production when Aerospike is absent.
    sessions = new SessionService(null);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: UserService, useValue: userService },
        { provide: JwtService, useValue: jwtService },
        { provide: ConfigService, useValue: { getOrThrow: () => TEST_SECRET } },
        { provide: REDIS_CLIENT, useValue: redis },
        { provide: LoginLockoutService, useValue: lockout },
        { provide: SessionService, useValue: sessions },
      ],
    }).compile();

    service = module.get(AuthService);
  });

  describe('login', () => {
    it('throws UnauthorizedException when email is not found', async () => {
      userService.findByEmailWithPassword.mockResolvedValue(null);

      await expect(
        service.login({ email: 'unknown@example.com', password: 'pass' }),
      ).rejects.toThrow(UnauthorizedException);
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
        service.login({ email: 'alice@example.com', password: 'correct' }),
      ).rejects.toThrow(UnauthorizedException);
    });

    it('throws UnauthorizedException when password is wrong', async () => {
      const hash = await bcrypt.hash('correct', 10);
      userService.findByEmailWithPassword.mockResolvedValue({
        ...mockUserWithPassword,
        passwordHash: hash,
      } as any);

      await expect(
        service.login({ email: 'alice@example.com', password: 'wrong' }),
      ).rejects.toThrow(UnauthorizedException);
    });

    it('returns access + refresh token pair on valid credentials', async () => {
      const hash = await bcrypt.hash('secret123', 10);
      userService.findByEmailWithPassword.mockResolvedValue({
        ...mockUserWithPassword,
        passwordHash: hash,
      } as any);

      const result = await service.login({
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
      // refresh token persisted in Redis with a TTL
      expect(redis.set).toHaveBeenCalledWith(
        expect.stringMatching(/^rt:user-123:/),
        '1',
        'PX',
        expect.any(Number),
      );
    });

    it('records an Aerospike session on successful login (fire-and-forget)', async () => {
      const createSpy = jest.spyOn(sessions, 'create');
      const hash = await bcrypt.hash('secret123', 10);
      userService.findByEmailWithPassword.mockResolvedValue({
        ...mockUserWithPassword,
        passwordHash: hash,
      } as any);

      await service.login(
        { email: 'alice@example.com', password: 'secret123' },
        '10.0.0.1',
      );

      expect(createSpy).toHaveBeenCalledWith(
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

      await service.login({
        email: 'alice@example.com',
        password: 'secret123',
      });

      expect(userService.recordLogin).toHaveBeenCalledWith(
        'user-123',
        'alice@example.com',
      );
    });

    it('checks lockout before password verification and rejects when locked', async () => {
      lockout.assertNotLocked.mockRejectedValue(new Error('locked'));

      await expect(
        service.login(
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
          { email: 'alice@example.com', password: 'wrong' },
          '1.2.3.4',
        ),
      ).rejects.toThrow(UnauthorizedException);
      expect(lockout.recordFailure).toHaveBeenCalledWith(
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
        { email: 'alice@example.com', password: 'secret123' },
        '1.2.3.4',
      );

      expect(lockout.reset).toHaveBeenCalledWith(
        'alice@example.com',
        '1.2.3.4',
      );
      expect(lockout.recordFailure).not.toHaveBeenCalled();
    });
  });

  describe('logout / isBlacklisted', () => {
    it('blacklists the access token jti until the token expiry', async () => {
      const exp = Math.floor(Date.now() / 1000) + 60;

      await service.logout('jti-1', exp);

      expect(redis.set).toHaveBeenCalledWith(
        'bl:jti-1',
        '1',
        'PX',
        expect.any(Number),
      );
    });

    it('does not blacklist an already-expired token', async () => {
      const exp = Math.floor(Date.now() / 1000) - 60;

      await service.logout('jti-1', exp);

      expect(redis.set).not.toHaveBeenCalled();
    });

    it('deletes the paired refresh token on logout', async () => {
      const exp = Math.floor(Date.now() / 1000) + 60;

      await service.logout(
        'jti-1',
        exp,
        encodeRefreshToken('user-123', 'tok-1'),
      );

      // key stores a hash of the tokenId, not the raw id
      expect(redis.del).toHaveBeenCalledWith(
        expect.stringMatching(/^rt:user-123:[0-9a-f]{64}$/),
      );
    });

    it('invalidates the Aerospike session on logout', async () => {
      const invalidateSpy = jest.spyOn(sessions, 'invalidate');
      const exp = Math.floor(Date.now() / 1000) + 60;

      await service.logout(
        'jti-1',
        exp,
        encodeRefreshToken('user-123', 'tok-1'),
      );

      expect(invalidateSpy).toHaveBeenCalledWith('user-123');
    });

    it('isBlacklisted returns true when the jti key exists', async () => {
      redis.exists.mockResolvedValue(1);
      await expect(service.isBlacklisted('jti-1')).resolves.toBe(true);
      expect(redis.exists).toHaveBeenCalledWith('bl:jti-1');
    });

    it('isBlacklisted returns false when the jti key is absent', async () => {
      redis.exists.mockResolvedValue(0);
      await expect(service.isBlacklisted('jti-1')).resolves.toBe(false);
    });
  });

  describe('refresh', () => {
    it('throws UnauthorizedException for a malformed refresh token', async () => {
      await expect(service.refresh('not-base64-json')).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it('throws UnauthorizedException when the refresh token is revoked', async () => {
      redis.exists.mockResolvedValue(0);

      await expect(
        service.refresh(encodeRefreshToken('user-123', 'tok-1')),
      ).rejects.toThrow(UnauthorizedException);
    });

    it('rejects a forged/tampered refresh token before any Redis lookup', async () => {
      redis.exists.mockResolvedValue(1); // Redis would say "valid" if reached
      // Attacker fabricates {userId, tokenId} with a bogus signature.
      const forged = Buffer.from(
        JSON.stringify({ userId: 'victim', tokenId: 'guess', sig: 'deadbeef' }),
      ).toString('base64url');

      await expect(service.refresh(forged)).rejects.toThrow(
        UnauthorizedException,
      );
      expect(redis.exists).not.toHaveBeenCalled(); // rejected on signature, pre-lookup
    });

    it('rotates the token and issues a new pair', async () => {
      redis.exists.mockResolvedValue(1);
      userService.findByIdForAuth.mockResolvedValue({
        id: 'user-123',
        email: 'alice@example.com',
        passwordHash: 'x',
      } as any);

      const result = await service.refresh(
        encodeRefreshToken('user-123', 'tok-1'),
      );

      expect(redis.del).toHaveBeenCalledWith(
        expect.stringMatching(/^rt:user-123:[0-9a-f]{64}$/),
      );
      expect(result.accessToken).toBe('signed.jwt.token');
      expect(typeof result.refreshToken).toBe('string');
    });

    it('re-creates the Aerospike session on refresh rotation', async () => {
      const createSpy = jest.spyOn(sessions, 'create');
      redis.exists.mockResolvedValue(1);
      userService.findByIdForAuth.mockResolvedValue({
        id: 'user-123',
        email: 'alice@example.com',
        passwordHash: 'x',
      } as any);

      await service.refresh(encodeRefreshToken('user-123', 'tok-1'));

      expect(createSpy).toHaveBeenCalledWith('user-123', 'alice@example.com');
    });

    it('throws UnauthorizedException when the user no longer exists', async () => {
      redis.exists.mockResolvedValue(1);
      userService.findByIdForAuth.mockResolvedValue(null);

      await expect(
        service.refresh(encodeRefreshToken('user-123', 'tok-1')),
      ).rejects.toThrow(UnauthorizedException);
    });
  });
});
