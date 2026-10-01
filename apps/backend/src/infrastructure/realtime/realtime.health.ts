import { Inject, Injectable } from '@nestjs/common';
import { CapabilityHealthIndicator } from '../capability';
import { REALTIME, type RealtimePort } from './realtime.port';

@Injectable()
export class RealtimeHealthIndicator extends CapabilityHealthIndicator {
  constructor(@Inject(REALTIME) realtime: RealtimePort) {
    super('realtime', realtime);
  }
}
