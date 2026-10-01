import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppError } from '../../../common/errors';
import { createLogger } from '../../../common/observability/logger';
import type { RateLimitKey, TenantId } from '../../../common/keyspace';
import {
  TENANT_DIRECTORY,
  type TenantDirectory,
} from '../../../common/tenant/tenant-directory.port';
import {
  RATE_LIMIT,
  type RateLimitPolicy,
  type RateLimitPort,
} from '../../../infrastructure/ratelimit/ratelimit.port';
import {
  SIGNUP_IP_RATE_LIMIT,
  SIGNUP_TENANT_RATE_LIMIT,
} from '../constants/user.constants';

/**
 * Admission rules for unauthenticated self sign-up: the tenant must be
 * registered, active and open to self sign-up, and sign-ups are counted per
 * client address (across tenants) and per tenant. The rate limit fails open
 * when its store is down, as the login lockout does.
 */
@Injectable()
export class SignupPolicyService {
  private readonly logger = createLogger('user');
  private readonly ipPolicy: RateLimitPolicy;
  private readonly tenantPolicy: RateLimitPolicy;

  constructor(
    @Inject(TENANT_DIRECTORY) private readonly tenants: TenantDirectory,
    @Inject(RATE_LIMIT) private readonly rateLimit: RateLimitPort,
    config: ConfigService,
  ) {
    const windowSeconds = config.getOrThrow<number>(
      'SIGNUP_RATE_LIMIT_WINDOW_S',
    );
    this.ipPolicy = {
      limit: config.getOrThrow<number>('SIGNUP_RATE_LIMIT_IP'),
      windowSeconds,
    };
    this.tenantPolicy = {
      limit: config.getOrThrow<number>('SIGNUP_RATE_LIMIT_TENANT'),
      windowSeconds,
    };
  }

  /**
   * An unregistered, suspended or closed tenant is refused with the one code
   * TENANT_SIGNUP_CLOSED, so an anonymous caller cannot tell which tenant
   * ids exist.
   */
  async assertAllowed(tenantId: TenantId, clientIp: string): Promise<void> {
    const record = await this.tenants.find(tenantId);
    if (!record || record.status !== 'active' || !record.selfSignup) {
      throw new AppError('TENANT_SIGNUP_CLOSED');
    }
    await this.count(SIGNUP_IP_RATE_LIMIT.global(clientIp), this.ipPolicy);
    await this.count(
      SIGNUP_TENANT_RATE_LIMIT.forTenant(tenantId),
      this.tenantPolicy,
    );
  }

  private async count(key: RateLimitKey, policy: RateLimitPolicy) {
    let allowed = true;
    let resetSeconds = 0;
    try {
      ({ allowed, resetSeconds } = await this.rateLimit.hit(key, policy));
    } catch (err) {
      this.logger.warn(
        'signup-rate-limit-unavailable',
        'Sign-up rate limit unavailable; allowing the sign-up',
        {},
        err,
      );
    }
    if (!allowed) {
      throw new AppError('RATE_LIMITED', {
        detail: 'Too many sign-ups, try again later',
        metadata: { retryAfterSeconds: String(resetSeconds) },
      });
    }
  }
}
