import { Inject, Injectable } from '@nestjs/common';
import { AppError } from '../../../common/errors';
import { createLogger } from '../../../common/observability/logger';
import type { KvKey, RateLimitKey, TenantId } from '../../../common/keyspace';
import type { CredentialAttempts } from '../../../common/auth/credential-attempts.port';
import { KV, type KvPort } from '../../../infrastructure/kv/kv.port';
import {
  RATE_LIMIT,
  type RateLimitPolicy,
  type RateLimitPort,
  type RateLimitResult,
} from '../../../infrastructure/ratelimit/ratelimit.port';
import {
  LOCKOUT_EMAIL_MAX,
  LOCKOUT_MAX_ATTEMPTS,
  LOCKOUT_WINDOW_S,
  LOGIN_EMAIL_RATE_LIMIT,
  LOGIN_IP_RATE_LIMIT,
  LOGIN_LOCKOUT_KEY,
  RPC_LOGIN_RATE_LIMIT,
  RPC_LOGIN_RATE_LIMIT_POLICY,
} from '../constants/auth.constants';

export { LOCKOUT_EMAIL_MAX, LOCKOUT_MAX_ATTEMPTS, LOCKOUT_WINDOW_S };

const IP_POLICY: RateLimitPolicy = {
  limit: LOCKOUT_MAX_ATTEMPTS,
  windowSeconds: LOCKOUT_WINDOW_S,
};
const EMAIL_POLICY: RateLimitPolicy = {
  limit: LOCKOUT_EMAIL_MAX,
  windowSeconds: LOCKOUT_WINDOW_S,
};

/**
 * Login lockout, per tenant (an email is unique within its tenant only).
 * Two failure counters in the ratelimit capability, each a 15-minute window:
 *   - email+IP  → LOCKOUT_MAX_ATTEMPTS (5)  — stops targeted brute force.
 *   - email     → LOCKOUT_EMAIL_MAX (30)     — stops an attacker rotating IPs,
 *     which on its own resets the per-IP counter.
 * When a failure brings a counter to its threshold, a lockout marker is set
 * in kv for the rest of that window; either marker ⇒ 429 before the password
 * is checked. A successful login clears the markers.
 *
 * Every store failure fails OPEN — an unavailable store must not lock
 * everyone out. The per-email counter's DoS risk (an attacker locking a
 * victim) is bounded by the higher threshold.
 */
@Injectable()
export class LoginLockoutService implements CredentialAttempts {
  private readonly logger = createLogger('auth');

  constructor(
    @Inject(RATE_LIMIT) private readonly rateLimit: RateLimitPort,
    @Inject(KV) private readonly kv: KvPort,
  ) {}

  /** Throws AUTH_LOGIN_LOCKED when the email+IP or the email counter reached its limit. */
  async assertNotLocked(
    tenantId: TenantId,
    email: string,
    ip: string,
  ): Promise<void> {
    const normalized = email.toLowerCase();
    const [ipLocked, emailLocked] = await Promise.all([
      this.isMarked(
        LOGIN_LOCKOUT_KEY.forTenant(tenantId, 'ip', normalized, ip),
      ),
      this.isMarked(LOGIN_LOCKOUT_KEY.forTenant(tenantId, 'email', normalized)),
    ]);
    if (ipLocked || emailLocked) {
      throw new AppError('AUTH_LOGIN_LOCKED', {
        metadata: { retryAfterSeconds: String(LOCKOUT_WINDOW_S) },
      });
    }
  }

  /** CredentialAttempts: the same check as login. */
  assertAllowed(tenantId: TenantId, email: string, ip: string): Promise<void> {
    return this.assertNotLocked(tenantId, email, ip);
  }

  /** Counts one failure on both counters, locking whichever reached its limit. */
  async recordFailure(
    tenantId: TenantId,
    email: string,
    ip: string,
  ): Promise<void> {
    const normalized = email.toLowerCase();
    await Promise.all([
      this.countFailure(
        LOGIN_IP_RATE_LIMIT.forTenant(tenantId, normalized, ip),
        IP_POLICY,
        LOGIN_LOCKOUT_KEY.forTenant(tenantId, 'ip', normalized, ip),
      ),
      this.countFailure(
        LOGIN_EMAIL_RATE_LIMIT.forTenant(tenantId, normalized),
        EMAIL_POLICY,
        LOGIN_LOCKOUT_KEY.forTenant(tenantId, 'email', normalized),
      ),
    ]);
  }

  /** Clears both lockout markers after a successful login. */
  async reset(tenantId: TenantId, email: string, ip: string): Promise<void> {
    const normalized = email.toLowerCase();
    await Promise.all([
      this.kv
        .del(LOGIN_LOCKOUT_KEY.forTenant(tenantId, 'ip', normalized, ip))
        .catch(() => false),
      this.kv
        .del(LOGIN_LOCKOUT_KEY.forTenant(tenantId, 'email', normalized))
        .catch(() => false),
    ]);
  }

  /**
   * RPC Login attempt limit per email (10 per 60 s), counted atomically on
   * every attempt, on top of the lockout. Fails open when the ratelimit
   * store is unavailable.
   */
  async assertRpcLoginAllowed(
    tenantId: TenantId,
    email: string,
  ): Promise<void> {
    let result: RateLimitResult;
    try {
      result = await this.rateLimit.hit(
        RPC_LOGIN_RATE_LIMIT.forTenant(tenantId, email.toLowerCase()),
        RPC_LOGIN_RATE_LIMIT_POLICY,
      );
    } catch (err) {
      this.logger.warn(
        'login-rate-limit-unavailable',
        'RPC login rate limit unavailable; allowing the attempt',
        {},
        err,
      );
      return;
    }
    if (!result.allowed) {
      throw new AppError('RATE_LIMITED', {
        detail: 'Too many login attempts',
        metadata: { retryAfterSeconds: String(result.resetSeconds) },
      });
    }
  }

  private isMarked(key: KvKey): Promise<boolean> {
    return this.kv.exists(key).catch(() => false);
  }

  private async countFailure(
    counter: RateLimitKey,
    policy: RateLimitPolicy,
    marker: KvKey,
  ): Promise<void> {
    try {
      const result = await this.rateLimit.hit(counter, policy);
      if (result.remaining === 0) {
        await this.kv.set(marker, true, {
          ttlSeconds: Math.max(1, result.resetSeconds),
        });
      }
    } catch {
      // fail open — see class doc
    }
  }
}
