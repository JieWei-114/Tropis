import { Injectable, Inject, HttpException, HttpStatus } from '@nestjs/common';
import type Redis from 'ioredis';
import { REDIS_CLIENT } from '../../../infrastructure/redis/redis.module';

export const LOCKOUT_MAX_ATTEMPTS = 5;
export const LOCKOUT_WINDOW_S = 15 * 60; // 15 minutes
const KEY_PREFIX = 'login:fail:'; // login:fail:{email}:{ip}

/**
 * Login lockout — after LOCKOUT_MAX_ATTEMPTS failed password attempts for
 * the same email+IP within LOCKOUT_WINDOW_S, further attempts are rejected
 * with 429 BEFORE the password is even checked (blunts credential stuffing
 * and per-account brute force). Counter resets on successful login.
 *
 * Redis failures fail open — an unavailable Redis must not lock everyone out.
 */
@Injectable()
export class LoginLockoutService {
  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  private key(email: string, ip: string): string {
    return `${KEY_PREFIX}${email.toLowerCase()}:${ip}`;
  }

  /** Throws 429 when the email+IP pair is currently locked out. */
  async assertNotLocked(email: string, ip: string): Promise<void> {
    const count = await this.redis.get(this.key(email, ip)).catch(() => null);
    if (count !== null && Number(count) >= LOCKOUT_MAX_ATTEMPTS) {
      throw new HttpException(
        'Too many failed login attempts — try again later',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }

  /** Increment the failure counter (starts the 15-min window on first failure). */
  async recordFailure(email: string, ip: string): Promise<void> {
    const key = this.key(email, ip);
    try {
      const count = await this.redis.incr(key);
      if (count === 1) await this.redis.expire(key, LOCKOUT_WINDOW_S);
    } catch {
      // fail open — see class doc
    }
  }

  /** Clear the counter after a successful login. */
  async reset(email: string, ip: string): Promise<void> {
    await this.redis.del(this.key(email, ip)).catch(() => undefined);
  }
}
