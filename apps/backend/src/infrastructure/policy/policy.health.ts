import { Inject, Injectable } from '@nestjs/common';
import { CapabilityHealthIndicator } from '../capability';
import { POLICY, type PolicyPort } from './policy.port';

@Injectable()
export class PolicyHealthIndicator extends CapabilityHealthIndicator {
  constructor(@Inject(POLICY) policy: PolicyPort) {
    super('policy', policy);
  }
}
