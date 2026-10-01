import { Inject, Injectable } from '@nestjs/common';
import { CapabilityHealthIndicator } from '../capability';
import { RATE_LIMIT, type RateLimitPort } from './ratelimit.port';

@Injectable()
export class RateLimitHealthIndicator extends CapabilityHealthIndicator {
  constructor(@Inject(RATE_LIMIT) rateLimit: RateLimitPort) {
    super('ratelimit', rateLimit);
  }
}
