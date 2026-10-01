import { Inject, Injectable } from '@nestjs/common';
import { CapabilityHealthIndicator } from '../capability';
import { SECRETS, type SecretsPort } from './secrets.port';

@Injectable()
export class SecretsHealthIndicator extends CapabilityHealthIndicator {
  constructor(@Inject(SECRETS) secrets: SecretsPort) {
    super('secrets', secrets);
  }
}
