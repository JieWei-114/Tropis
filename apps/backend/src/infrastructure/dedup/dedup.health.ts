import { Inject, Injectable } from '@nestjs/common';
import { CapabilityHealthIndicator } from '../capability';
import { DEDUP, type DedupPort } from './dedup.port';

@Injectable()
export class DedupHealthIndicator extends CapabilityHealthIndicator {
  constructor(@Inject(DEDUP) dedup: DedupPort) {
    super('dedup', dedup);
  }
}
