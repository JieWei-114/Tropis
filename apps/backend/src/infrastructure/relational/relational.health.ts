import { Inject, Injectable } from '@nestjs/common';
import { CapabilityHealthIndicator } from '../capability';
import { RELATIONAL, type RelationalPort } from './relational.port';

@Injectable()
export class RelationalHealthIndicator extends CapabilityHealthIndicator {
  constructor(@Inject(RELATIONAL) relational: RelationalPort) {
    super('relational', relational);
  }
}
