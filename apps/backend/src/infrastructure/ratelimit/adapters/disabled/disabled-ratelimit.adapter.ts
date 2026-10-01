import {
  capabilityDisabled,
  CapabilityDisabledError,
  type CapabilityHealth,
} from '../../../capability';
import type { RateLimitPort, RateLimitResult } from '../../ratelimit.port';

export class DisabledRateLimitAdapter implements RateLimitPort {
  hit(): Promise<RateLimitResult> {
    return Promise.reject(new CapabilityDisabledError('ratelimit', 'hit'));
  }

  health(): Promise<CapabilityHealth> {
    return Promise.resolve(capabilityDisabled());
  }
}
