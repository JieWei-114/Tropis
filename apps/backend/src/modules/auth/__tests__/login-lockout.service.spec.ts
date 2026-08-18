import { Test, TestingModule } from '@nestjs/testing';
import { HttpException } from '@nestjs/common';
import {
  LoginLockoutService,
  LOCKOUT_MAX_ATTEMPTS,
  LOCKOUT_EMAIL_MAX,
  LOCKOUT_WINDOW_S,
} from '../services/login-lockout.service';
import { REDIS_CLIENT } from '../../../infrastructure/redis/redis.module';

describe('LoginLockoutService', () => {
  let service: LoginLockoutService;
  let redis: {
    get: jest.Mock;
    eval: jest.Mock;
    del: jest.Mock;
  };

  const EMAIL = 'Alice@Example.com';
  const IP = '1.2.3.4';
  const IP_KEY = 'login:fail:alice@example.com:1.2.3.4';
  const EMAIL_KEY = 'login:fail:email:alice@example.com';

  beforeEach(async () => {
    redis = {
      get: jest.fn().mockResolvedValue(null),
      eval: jest.fn().mockResolvedValue(1),
      del: jest.fn().mockResolvedValue(1),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        LoginLockoutService,
        { provide: REDIS_CLIENT, useValue: redis },
      ],
    }).compile();

    service = module.get(LoginLockoutService);
  });

  describe('assertNotLocked', () => {
    it('passes when there are no recorded failures', async () => {
      await expect(service.assertNotLocked(EMAIL, IP)).resolves.toBeUndefined();
      expect(redis.get).toHaveBeenCalledWith(IP_KEY);
      expect(redis.get).toHaveBeenCalledWith(EMAIL_KEY);
    });

    it('passes when failures are below the threshold', async () => {
      redis.get.mockResolvedValue(String(LOCKOUT_MAX_ATTEMPTS - 1));
      await expect(service.assertNotLocked(EMAIL, IP)).resolves.toBeUndefined();
    });

    it('throws 429 when the per-IP threshold is reached', async () => {
      redis.get.mockImplementation((key: string) =>
        Promise.resolve(key === IP_KEY ? String(LOCKOUT_MAX_ATTEMPTS) : null),
      );
      const err = await service.assertNotLocked(EMAIL, IP).catch((e) => e);
      expect(err).toBeInstanceOf(HttpException);
      expect((err as HttpException).getStatus()).toBe(429);
    });

    it('throws 429 when the per-email threshold is reached (IP-rotation defence)', async () => {
      redis.get.mockImplementation((key: string) =>
        Promise.resolve(key === EMAIL_KEY ? String(LOCKOUT_EMAIL_MAX) : null),
      );
      const err = await service.assertNotLocked(EMAIL, IP).catch((e) => e);
      expect(err).toBeInstanceOf(HttpException);
      expect((err as HttpException).getStatus()).toBe(429);
    });

    it('fails open when Redis is unavailable', async () => {
      redis.get.mockRejectedValue(new Error('redis down'));
      await expect(service.assertNotLocked(EMAIL, IP)).resolves.toBeUndefined();
    });
  });

  describe('recordFailure', () => {
    it('atomically bumps both counters with the 15-min TTL', async () => {
      await service.recordFailure(EMAIL, IP);
      // one eval per counter (Lua does incr+expire atomically)
      expect(redis.eval).toHaveBeenCalledWith(
        expect.any(String),
        1,
        IP_KEY,
        LOCKOUT_WINDOW_S,
      );
      expect(redis.eval).toHaveBeenCalledWith(
        expect.any(String),
        1,
        EMAIL_KEY,
        LOCKOUT_WINDOW_S,
      );
    });

    it('swallows Redis errors (fail open)', async () => {
      redis.eval.mockRejectedValue(new Error('redis down'));
      await expect(service.recordFailure(EMAIL, IP)).resolves.toBeUndefined();
    });
  });

  describe('reset', () => {
    it('deletes both counter keys', async () => {
      await service.reset(EMAIL, IP);
      expect(redis.del).toHaveBeenCalledWith(IP_KEY);
      expect(redis.del).toHaveBeenCalledWith(EMAIL_KEY);
    });

    it('swallows Redis errors', async () => {
      redis.del.mockRejectedValue(new Error('redis down'));
      await expect(service.reset(EMAIL, IP)).resolves.toBeUndefined();
    });
  });
});
