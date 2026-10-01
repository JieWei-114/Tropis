import { Inject, Injectable } from '@nestjs/common';
import { CapabilityHealthIndicator } from '../capability';
import { LOCK, type LockPort } from './lock.port';

@Injectable()
export class LockHealthIndicator extends CapabilityHealthIndicator {
  constructor(@Inject(LOCK) lock: LockPort) {
    super('lock', lock);
  }
}
