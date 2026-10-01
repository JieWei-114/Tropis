import { createLogger } from '../../../../common/observability/logger';
import { capabilityUp, type CapabilityHealth } from '../../../capability';
import { assertSingleRecipient } from '../../mail-recipient';
import type { MailMessage, MailPort } from '../../mail.port';

/** Development adapter: logs each message instead of sending it. */
export class LogMailAdapter implements MailPort {
  private readonly logger = createLogger('mail');

  send(message: MailMessage): Promise<void> {
    try {
      assertSingleRecipient(message.to);
    } catch (err) {
      return Promise.reject(err as Error);
    }
    this.logger.info('message-logged', 'Mail message logged, not sent', {
      'mail.recipient_email': message.to,
      'mail.subject': message.subject,
    });
    return Promise.resolve();
  }

  health(): Promise<CapabilityHealth> {
    return Promise.resolve(capabilityUp('log'));
  }
}
