import type { JobQueueDefinition } from '../../../infrastructure/jobs/jobs.registry';

export const QUEUE_NOTIFICATION = 'notification';

/** Three attempts with backoff; exhausted jobs move to the dead-letter queue. */
export const NOTIFICATION_QUEUE: JobQueueDefinition = {
  name: QUEUE_NOTIFICATION,
  defaults: {
    attempts: 3,
    backoff: { type: 'exponential', delayMs: 2000 },
    removeOnComplete: 100,
    removeOnFail: 500,
  },
  deadLetter: true,
};

export const JOB_SEND_NOTIFICATION = 'send-notification';

export interface NotificationJobData {
  /** Owning tenant; an in-app push reaches only this tenant's user room. */
  tenantId: string;
  userId: string;
  channel: 'email' | 'sms' | 'in-app';
  template: string;
  payload: Record<string, unknown>;
}
