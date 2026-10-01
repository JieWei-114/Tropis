import { Inject, Injectable } from '@nestjs/common';
import { CapabilityHealthIndicator } from '../capability';
import { SIGNING, type SigningPort } from './signing.port';

@Injectable()
export class SigningHealthIndicator extends CapabilityHealthIndicator {
  constructor(@Inject(SIGNING) signing: SigningPort) {
    super('signing', signing);
  }
}
