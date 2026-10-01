import { Inject, Injectable } from '@nestjs/common';
import { CapabilityHealthIndicator } from '../capability';
import { OLAP, type OlapPort } from './olap.port';

@Injectable()
export class OlapHealthIndicator extends CapabilityHealthIndicator {
  constructor(@Inject(OLAP) olap: OlapPort) {
    super('olap', olap);
  }
}
