import { Inject, Injectable } from '@nestjs/common';
import { CapabilityHealthIndicator } from '../capability';
import { VECTOR, type VectorPort } from './vector.port';

@Injectable()
export class VectorHealthIndicator extends CapabilityHealthIndicator {
  constructor(@Inject(VECTOR) vector: VectorPort) {
    super('vector', vector);
  }
}
