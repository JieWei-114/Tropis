import { Injectable } from '@nestjs/common';
import { CapabilityHealthIndicator } from '../capability';
import { EventConsumer } from './event-consumer';

/** Down while a consumer this process started is not subscribed. */
@Injectable()
export class ConsumersHealthIndicator extends CapabilityHealthIndicator {
  constructor(consumer: EventConsumer) {
    super('consumers', consumer);
  }
}
