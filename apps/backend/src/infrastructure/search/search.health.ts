import { Inject, Injectable } from '@nestjs/common';
import { CapabilityHealthIndicator } from '../capability';
import { SEARCH, type SearchPort } from './search.port';

@Injectable()
export class SearchHealthIndicator extends CapabilityHealthIndicator {
  constructor(@Inject(SEARCH) search: SearchPort) {
    super('search', search);
  }
}
