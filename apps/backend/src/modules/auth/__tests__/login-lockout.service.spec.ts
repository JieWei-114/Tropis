import { toTenantId } from '../../../common/keyspace';
import { InMemoryKvAdapter } from '../../../infrastructure/kv/__tests__/in-memory-kv.adapter';
import { InMemoryRateLimitAdapter } from '../../../infrastructure/ratelimit/__tests__/in-memory-ratelimit.adapter';
import {
  LOGIN_EMAIL_RATE_LIMIT,
  LOGIN_IP_RATE_LIMIT,
  RPC_LOGIN_RATE_LIMIT,
} from '../constants/auth.constants';
import {
  LoginLockoutService,
  LOCKOUT_MAX_ATTEMPTS,
  LOCKOUT_EMAIL_MAX,
  LOCKOUT_WINDOW_S,
} from '../services/login-lockout.service';

describe('LoginLockoutService', () => {
  let service: LoginLockoutService;
  let rateLimit: InMemoryRateLimitAdapter;
  let kv: InMemoryKvAdapter;

  const T = toTenantId('acme');
  const EMAIL = 'Alice@Example.com';
  const IP = '1.2.3.4';

  const fail = async (times: number, email = EMAIL, ip = IP) => {
    for (let i = 0; i < times; i++) await service.recordFailure(T, email, ip);
  };

  const status = (err: unknown) =>
    (err as { httpStatus?: number; code?: string }).code === 'AUTH_LOGIN_LOCKED'
      ? 429
      : err;

  beforeEach(() => {
    rateLimit = new InMemoryRateLimitAdapter();
    kv = new InMemoryKvAdapter();
    service = new LoginLockoutService(rateLimit, kv);
  });

  describe('assertNotLocked', () => {
    it('passes when there are no recorded failures', async () => {
      await expect(
        service.assertNotLocked(T, EMAIL, IP),
      ).resolves.toBeUndefined();
    });

    it('passes when failures are below the threshold', async () => {
      await fail(LOCKOUT_MAX_ATTEMPTS - 1);
      await expect(
        service.assertNotLocked(T, EMAIL, IP),
      ).resolves.toBeUndefined();
    });

    it('throws 429 once the per-IP threshold is reached', async () => {
      await fail(LOCKOUT_MAX_ATTEMPTS);
      const err = await service.assertNotLocked(T, EMAIL, IP).catch((e) => e);
      expect(status(err)).toBe(429);
    });

    it('says how long the lockout lasts, for the Retry-After header', async () => {
      await fail(LOCKOUT_MAX_ATTEMPTS);
      const err = await service.assertNotLocked(T, EMAIL, IP).catch((e) => e);
      expect(err).toMatchObject({
        metadata: { retryAfterSeconds: String(LOCKOUT_WINDOW_S) },
      });
    });

    it('locks per email+IP, not per IP alone', async () => {
      await fail(LOCKOUT_MAX_ATTEMPTS);
      await expect(
        service.assertNotLocked(T, 'bob@example.com', IP),
      ).resolves.toBeUndefined();
    });

    it('throws 429 once the per-email threshold is reached from rotating IPs (IP-rotation defence)', async () => {
      for (let i = 0; i < LOCKOUT_EMAIL_MAX; i++) {
        await service.recordFailure(T, EMAIL, `10.0.0.${i}`);
      }
      const err = await service
        .assertNotLocked(T, EMAIL, '192.168.1.1')
        .catch((e) => e);
      expect(status(err)).toBe(429);
    });

    it('matches the email case-insensitively', async () => {
      await fail(LOCKOUT_MAX_ATTEMPTS, 'ALICE@example.com');
      const err = await service
        .assertNotLocked(T, 'alice@EXAMPLE.com', IP)
        .catch((e) => e);
      expect(status(err)).toBe(429);
    });

    it('fails open when kv is unavailable', async () => {
      await fail(LOCKOUT_MAX_ATTEMPTS);
      jest.spyOn(kv, 'exists').mockRejectedValue(new Error('down'));
      await expect(
        service.assertNotLocked(T, EMAIL, IP),
      ).resolves.toBeUndefined();
    });
  });

  it('keeps lockouts per tenant', async () => {
    await fail(LOCKOUT_MAX_ATTEMPTS);
    await expect(
      service.assertNotLocked(toTenantId('globex'), EMAIL, IP),
    ).resolves.toBeUndefined();
  });

  describe('recordFailure', () => {
    it('counts on both counters with the 15-min window', async () => {
      const hit = jest.spyOn(rateLimit, 'hit');
      await service.recordFailure(T, EMAIL, IP);
      expect(hit).toHaveBeenCalledWith(
        LOGIN_IP_RATE_LIMIT.forTenant(T, 'alice@example.com', IP),
        { limit: LOCKOUT_MAX_ATTEMPTS, windowSeconds: LOCKOUT_WINDOW_S },
      );
      expect(hit).toHaveBeenCalledWith(
        LOGIN_EMAIL_RATE_LIMIT.forTenant(T, 'alice@example.com'),
        { limit: LOCKOUT_EMAIL_MAX, windowSeconds: LOCKOUT_WINDOW_S },
      );
    });

    it('swallows store errors (fail open)', async () => {
      jest.spyOn(rateLimit, 'hit').mockRejectedValue(new Error('down'));
      await expect(
        service.recordFailure(T, EMAIL, IP),
      ).resolves.toBeUndefined();
    });
  });

  describe('reset', () => {
    it('lifts an active lockout', async () => {
      await fail(LOCKOUT_MAX_ATTEMPTS);
      await service.reset(T, EMAIL, IP);
      await expect(
        service.assertNotLocked(T, EMAIL, IP),
      ).resolves.toBeUndefined();
    });

    it('swallows store errors', async () => {
      jest.spyOn(kv, 'del').mockRejectedValue(new Error('down'));
      await expect(service.reset(T, EMAIL, IP)).resolves.toBeUndefined();
    });
  });

  describe('assertRpcLoginAllowed', () => {
    it('allows 10 attempts per lower-cased email in the window, then rejects', async () => {
      const hit = jest.spyOn(rateLimit, 'hit');
      for (let i = 0; i < 10; i++) {
        await expect(
          service.assertRpcLoginAllowed(T, 'Alice@Example.com'),
        ).resolves.toBeUndefined();
      }
      await expect(
        service.assertRpcLoginAllowed(T, 'alice@example.com'),
      ).rejects.toMatchObject({ code: 'RATE_LIMITED' });
      expect(hit).toHaveBeenCalledWith(
        RPC_LOGIN_RATE_LIMIT.forTenant(T, 'alice@example.com'),
        { limit: 10, windowSeconds: 60 },
      );
    });

    it('fails open when the ratelimit store is down', async () => {
      jest.spyOn(rateLimit, 'hit').mockRejectedValue(new Error('down'));
      await expect(
        service.assertRpcLoginAllowed(T, 'a@example.com'),
      ).resolves.toBeUndefined();
    });
  });
});
