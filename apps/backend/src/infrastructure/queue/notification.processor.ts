import { Processor, WorkerHost, OnWorkerEvent } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Job, Queue } from 'bullmq';
import {
  QUEUE_NOTIFICATION,
  QUEUE_DLQ,
  JOB_SEND_NOTIFICATION,
} from './queue.constants';
import { NotificationService } from '../../modules/notification/services/notification.service';
import type { NotificationJobData } from './queue.service';

@Processor(QUEUE_NOTIFICATION)
export class NotificationProcessor extends WorkerHost {
  private readonly logger = new Logger(NotificationProcessor.name);

  constructor(
    private readonly notifications: NotificationService,
    @InjectQueue(QUEUE_DLQ) private readonly dlq: Queue,
  ) {
    super();
  }

  async process(job: Job<NotificationJobData>): Promise<void> {
    this.logger.log(
      `Processing job ${job.name} (id=${job.id}) for user ${job.data.userId}`,
    );

    if (job.name === JOB_SEND_NOTIFICATION) {
      const { userId, channel, template, payload } = job.data;

      if (channel === 'email' && payload['to']) {
        await this.notifications.sendEmail({
          to: payload['to'] as string,
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
          userId,
          event: template,
          data: payload,
        });
      }
    }
  }

  // After all BullMQ retries are exhausted, move the job to the DLQ
  @OnWorkerEvent('failed')
  async onFailed(job: Job<NotificationJobData>, err: Error): Promise<void> {
    const attemptsLeft = (job.opts.attempts ?? 1) - (job.attemptsMade ?? 0);
    if (attemptsLeft <= 0) {
      await this.dlq.add(
        job.name,
        {
          ...job.data,
          __sourceQueue: QUEUE_NOTIFICATION,
          __failReason: err.message,
        },
        { removeOnComplete: false, removeOnFail: false },
      );

      this.logger.warn(
        `Job ${job.id} moved to DLQ after ${job.attemptsMade} attempts: ${err.message}`,
      );
    }
  }
}
