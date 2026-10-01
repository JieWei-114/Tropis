import { Inject, Injectable } from '@nestjs/common';
import { CapabilityHealthIndicator } from '../capability';
import { CACHE, type CachePort } from './cache.port';

@Injectable()
export class CacheHealthIndicator extends CapabilityHealthIndicator {
  constructor(@Inject(CACHE) cache: CachePort) {
    super('cache', cache);
  }
}
