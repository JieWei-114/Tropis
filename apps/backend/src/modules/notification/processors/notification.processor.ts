import { parseTenantId } from '../../../common/tenant/tenant.context';
import { createLogger } from '../../../common/observability/logger';
import { JobHandler } from '../../../infrastructure/jobs/job-handler.decorator';
import { assertSingleRecipient } from '../../../infrastructure/mail/mail-recipient';
import type {
  JobContext,
  JobProcessor,
} from '../../../infrastructure/jobs/jobs.port';
import {
  JOB_SEND_NOTIFICATION,
  QUEUE_NOTIFICATION,
  type NotificationJobData,
} from '../constants/notification.constants';
import { NotificationService } from '../services/notification.service';

/**
 * Consumer of the notification queue. A thrown error fails the attempt; the
 * jobs capability retries it and, once retries are exhausted, moves it to the
 * dead-letter queue. An email job whose recipient is not one address fails
 * permanently (VALIDATION_FAILED), without retries.
 */
@JobHandler(QUEUE_NOTIFICATION)
export class NotificationProcessor implements JobProcessor<NotificationJobData> {
  private readonly logger = createLogger('notification');

  constructor(private readonly notifications: NotificationService) {}

  async process(job: JobContext<NotificationJobData>): Promise<void> {
    this.logger.debug('job-processing', 'Processing notification job', {
      'job.name': job.name,
      'messaging.message.id': job.id,
      'user.id': job.data.userId,
    });

    if (job.name === JOB_SEND_NOTIFICATION) {
      const { tenantId, userId, channel, template, payload } = job.data;

      if (channel === 'email' && payload['to']) {
        const to = payload['to'];
        assertSingleRecipient(to);
        await this.notifications.sendEmail({
          to,
          subject: (payload['subject'] as string) ?? template,
          html: (payload['html'] as string) ?? `<p>${template}</p>`,
          text: payload['text'] as string,
        });
      }

      if (channel === 'sms' && payload['to']) {
        await this.notifications.sendSms({
          to: payload['to'] as string,
          body: (payload['body'] as string) ?? template,
        });
      }

      if (channel === 'in-app') {
        await this.notifications.sendPush({
          tenantId: parseTenantId(tenantId),
          userId,
          event: template,
          data: payload,
        });
      }
    }
  }
}
