import { Inject, Injectable } from '@nestjs/common';
import type { TenantId } from '../../../common/keyspace';
import { createLogger } from '../../../common/observability/logger';
import {
  JOBS,
  type EnqueuedJob,
  type JobsPort,
} from '../../../infrastructure/jobs/jobs.port';
import { MAIL, type MailPort } from '../../../infrastructure/mail/mail.port';
import {
  REALTIME,
  type RealtimePort,
} from '../../../infrastructure/realtime/realtime.port';
import {
  JOB_SEND_NOTIFICATION,
  QUEUE_NOTIFICATION,
  type NotificationJobData,
} from '../constants/notification.constants';

export interface EmailPayload {
  to: string;
  subject: string;
  html: string;
  text?: string;
}

export interface SmsPayload {
  to: string; // E.164 format e.g. "+60123456789"
  body: string;
}

export interface PushPayload {
  tenantId: TenantId;
  userId: string;
  event: string;
  data: Record<string, unknown>;
}

@Injectable()
export class NotificationService {
  private readonly logger = createLogger('notification');

  constructor(
    @Inject(REALTIME) private readonly realtime: RealtimePort,
    @Inject(MAIL) private readonly mail: MailPort,
    @Inject(JOBS) private readonly jobs: JobsPort,
  ) {}

  /**
   * Queues a notification for the notification worker, which retries it and
   * dead-letters it once retries are exhausted. A `jobId` makes the enqueue
   * idempotent: a second enqueue with the same id is dropped.
   */
  enqueue(job: NotificationJobData, jobId?: string): Promise<EnqueuedJob> {
    return this.jobs.enqueue(QUEUE_NOTIFICATION, JOB_SEND_NOTIFICATION, job, {
      jobId,
    });
  }

  /**
   * Rejects when the send fails, so the caller's retry engages: the job is
   * retried and then dead-lettered, the workflow activity retried by the
   * engine. The caller's failure handling logs it.
   */
  async sendEmail(payload: EmailPayload): Promise<void> {
    await this.mail.send(payload);
    this.logger.debug('email-sent', 'Email sent', {
      'mail.subject': payload.subject,
    });
  }

  /** No SMS gateway is wired: the message is logged, not sent. */
  sendSms(payload: SmsPayload): Promise<void> {
    this.logger.info(
      'sms-stubbed',
      'SMS logged by the stub provider, not sent',
      {
        'sms.body_length': payload.body.length,
      },
    );
    return Promise.resolve();
  }

  async sendPush(payload: PushPayload): Promise<void> {
    await this.realtime.publishToUser(
      payload.tenantId,
      payload.userId,
      payload.event,
      payload.data,
    );
    this.logger.debug('push-sent', 'In-app push sent', {
      'user.id': payload.userId,
      'notification.event': payload.event,
    });
  }

  /** Best effort over every channel given: a failed one is logged, not thrown. */
  async sendAll(opts: {
    email?: EmailPayload;
    sms?: SmsPayload;
    push?: PushPayload;
  }): Promise<void> {
    const tasks: Array<{ channel: string; run: Promise<void> }> = [];
    if (opts.email) {
      tasks.push({ channel: 'email', run: this.sendEmail(opts.email) });
    }
    if (opts.sms) tasks.push({ channel: 'sms', run: this.sendSms(opts.sms) });
    if (opts.push) {
      tasks.push({ channel: 'in-app', run: this.sendPush(opts.push) });
    }
    const results = await Promise.allSettled(tasks.map((t) => t.run));
    results.forEach((result, i) => {
      if (result.status === 'rejected') {
        this.logger.warn(
          'notification-send-failed',
          'A notification channel failed; the others were sent',
          { 'notification.channel': tasks[i].channel },
          result.reason,
        );
      }
    });
  }
}
