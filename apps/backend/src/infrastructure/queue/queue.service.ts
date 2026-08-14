import { Injectable } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue, JobsOptions } from 'bullmq';
import { QUEUE_NOTIFICATION, QUEUE_FILE_PROCESSING } from './queue.constants';

export interface NotificationJobData {
  userId: string;
  channel: 'email' | 'sms' | 'in-app';
  template: string;
  payload: Record<string, unknown>;
}

export interface FileProcessingJobData {
  fileKey: string;
  bucket: string;
  userId: string;
  operation: string;
}

@Injectable()
export class QueueService {
  constructor(
    @InjectQueue(QUEUE_NOTIFICATION) private readonly notificationQueue: Queue,
    @InjectQueue(QUEUE_FILE_PROCESSING) private readonly fileQueue: Queue,
  ) {}

  async enqueueNotification(
    jobName: string,
    data: NotificationJobData,
    opts?: JobsOptions,
  ) {
    return this.notificationQueue.add(jobName, data, {
      attempts: 3,
      backoff: { type: 'exponential', delay: 2000 },
      removeOnComplete: 100,
      removeOnFail: 500,
      ...opts,
    });
  }

  async enqueueFileProcessing(
    jobName: string,
    data: FileProcessingJobData,
    opts?: JobsOptions,
  ) {
    return this.fileQueue.add(jobName, data, {
      attempts: 2,
      backoff: { type: 'fixed', delay: 5000 },
      removeOnComplete: 50,
      removeOnFail: 200,
      ...opts,
    });
  }

  // Schedule a delayed job — e.g. send reminder email in 30 minutes
  async enqueueDelayedNotification(
    jobName: string,
    data: NotificationJobData,
    delayMs: number,
  ) {
    return this.enqueueNotification(jobName, data, { delay: delayMs });
  }

  async getNotificationQueueStats() {
    const [waiting, active, completed, failed] = await Promise.all([
      this.notificationQueue.getWaitingCount(),
      this.notificationQueue.getActiveCount(),
      this.notificationQueue.getCompletedCount(),
      this.notificationQueue.getFailedCount(),
    ]);
    return { waiting, active, completed, failed };
  }
}
