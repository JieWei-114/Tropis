import { Inject, Injectable } from '@nestjs/common';
import { CapabilityHealthIndicator } from '../capability';
import { MAIL, type MailPort } from './mail.port';

@Injectable()
export class MailHealthIndicator extends CapabilityHealthIndicator {
  constructor(@Inject(MAIL) mail: MailPort) {
    super('mail', mail);
  }
}
