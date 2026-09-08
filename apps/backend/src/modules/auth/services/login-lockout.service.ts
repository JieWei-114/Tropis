import { Injectable, Inject, HttpException, HttpStatus } from '@nestjs/common';
import type Redis from 'ioredis';
import { REDIS_CLIENT } from '../../../infrastructure/redis/redis.module';

export const LOCKOUT_MAX_ATTEMPTS = 5; // per email+IP (targeted brute force)
export const LOCKOUT_EMAIL_MAX = 30; // per email across ALL IPs (blunts IP rotation)
export const LOCKOUT_WINDOW_S = 15 * 60; // 15 minutes
const IP_PREFIX = 'login:fail:'; // login:fail:{email}:{ip}
const EMAIL_PREFIX = 'login:fail:email:'; // login:fail:email:{email}

/**
 * Login lockout. Two counters, both sliding 15-min windows:
 *   - email+IP  → LOCKOUT_MAX_ATTEMPTS (5)  — stops targeted brute force.
 *   - email     → LOCKOUT_EMAIL_MAX (30)     — stops an attacker rotating IPs,
 *     which on its own resets the per-IP counter.
 * Either threshold reached ⇒ 429 before the password is checked.
 *
 * INCR+EXPIRE run atomically in one Lua script: a crash between the two would
 * leave a TTL-less key and lock an email+IP out forever.
 *
 * Redis failures fail OPEN — an unavailable Redis must not lock everyone out.
 * The per-email counter's DoS risk (an attacker locking a victim) is bounded by
 * the higher threshold; a hard per-email lock is intentionally avoided.
 */
@Injectable()
export class LoginLockoutService {
  // KEYS[1]=key ARGV[1]=window → atomic incr + (re)set TTL, returns new count.
  private static readonly INCR_EXPIRE =
    'local c = redis.call("incr", KEYS[1]); redis.call("expire", KEYS[1], ARGV[1]); return c';

  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  private ipKey(email: string, ip: string): string {
    return `${IP_PREFIX}${email.toLowerCase()}:${ip}`;
  }
  private emailKey(email: string): string {
    return `${EMAIL_PREFIX}${email.toLowerCase()}`;
  }

  /** Throws 429 when either the email+IP or the email counter is over its limit. */
  async assertNotLocked(email: string, ip: string): Promise<void> {
    const [ipCount, emailCount] = await Promise.all([
      this.redis.get(this.ipKey(email, ip)).catch(() => null),
      this.redis.get(this.emailKey(email)).catch(() => null),
    ]);
    const locked =
      (ipCount !== null && Number(ipCount) >= LOCKOUT_MAX_ATTEMPTS) ||
      (emailCount !== null && Number(emailCount) >= LOCKOUT_EMAIL_MAX);
    if (locked) {
      throw new HttpException(
        'Too many failed login attempts — try again later',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }

  /** Atomically bump both counters (each starts/refreshes its 15-min window). */
  async recordFailure(email: string, ip: string): Promise<void> {
    try {
      await Promise.all([
        this.redis.eval(
          LoginLockoutService.INCR_EXPIRE,
          1,
          this.ipKey(email, ip),
          LOCKOUT_WINDOW_S,
        ),
        this.redis.eval(
          LoginLockoutService.INCR_EXPIRE,
          1,
          this.emailKey(email),
          LOCKOUT_WINDOW_S,
        ),
      ]);
    } catch {
      // fail open — see class doc
    }
  }

  /** Clear both counters after a successful login. */
  async reset(email: string, ip: string): Promise<void> {
    await Promise.all([
      this.redis.del(this.ipKey(email, ip)).catch(() => undefined),
      this.redis.del(this.emailKey(email)).catch(() => undefined),
    ]);
  }
}
