import { Test, TestingModule } from '@nestjs/testing';
import { HttpException } from '@nestjs/common';
import {
  LoginLockoutService,
  LOCKOUT_MAX_ATTEMPTS,
  LOCKOUT_WINDOW_S,
} from '../services/login-lockout.service';
import { REDIS_CLIENT } from '../../../infrastructure/redis/redis.module';

describe('LoginLockoutService', () => {
  let service: LoginLockoutService;
  let redis: {
    get: jest.Mock;
    incr: jest.Mock;
    expire: jest.Mock;
    del: jest.Mock;
  };

  const EMAIL = 'Alice@Example.com';
  const IP = '1.2.3.4';
  const KEY = 'login:fail:alice@example.com:1.2.3.4';

  beforeEach(async () => {
    redis = {
      get: jest.fn().mockResolvedValue(null),
      incr: jest.fn().mockResolvedValue(1),
      expire: jest.fn().mockResolvedValue(1),
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
      expect(redis.get).toHaveBeenCalledWith(KEY);
    });

    it('passes when failures are below the threshold', async () => {
      redis.get.mockResolvedValue(String(LOCKOUT_MAX_ATTEMPTS - 1));
      await expect(service.assertNotLocked(EMAIL, IP)).resolves.toBeUndefined();
    });

    it('throws 429 when the threshold is reached', async () => {
      redis.get.mockResolvedValue(String(LOCKOUT_MAX_ATTEMPTS));

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
    it('increments the counter and sets the 15-min TTL on first failure', async () => {
      redis.incr.mockResolvedValue(1);

      await service.recordFailure(EMAIL, IP);

      expect(redis.incr).toHaveBeenCalledWith(KEY);
      expect(redis.expire).toHaveBeenCalledWith(KEY, LOCKOUT_WINDOW_S);
    });

    it('does not reset the TTL on subsequent failures', async () => {
      redis.incr.mockResolvedValue(3);

      await service.recordFailure(EMAIL, IP);

      expect(redis.expire).not.toHaveBeenCalled();
    });

    it('swallows Redis errors (fail open)', async () => {
      redis.incr.mockRejectedValue(new Error('redis down'));
      await expect(service.recordFailure(EMAIL, IP)).resolves.toBeUndefined();
    });
  });

  describe('reset', () => {
    it('deletes the counter key', async () => {
      await service.reset(EMAIL, IP);
      expect(redis.del).toHaveBeenCalledWith(KEY);
    });

    it('swallows Redis errors', async () => {
      redis.del.mockRejectedValue(new Error('redis down'));
      await expect(service.reset(EMAIL, IP)).resolves.toBeUndefined();
    });
  });
});
