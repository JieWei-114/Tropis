import { Inject, Injectable } from '@nestjs/common';
import { CapabilityHealthIndicator } from '../capability';
import { MESSAGING, type MessagingAdapter } from './messaging.port';

/** Probes whichever adapter MESSAGING_ADAPTER selected. */
@Injectable()
export class MessagingHealthIndicator extends CapabilityHealthIndicator {
  constructor(@Inject(MESSAGING) broker: MessagingAdapter) {
    super('messaging', broker);
  }
}
