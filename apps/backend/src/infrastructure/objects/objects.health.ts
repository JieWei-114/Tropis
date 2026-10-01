import { Inject, Injectable } from '@nestjs/common';
import { CapabilityHealthIndicator } from '../capability';
import { OBJECTS, type ObjectsPort } from './objects.port';

@Injectable()
export class ObjectsHealthIndicator extends CapabilityHealthIndicator {
  constructor(@Inject(OBJECTS) objects: ObjectsPort) {
    super('objects', objects);
  }
}
