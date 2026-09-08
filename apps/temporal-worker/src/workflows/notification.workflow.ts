import { proxyActivities, sleep } from '@temporalio/workflow';
import type { NotificationActivities } from '../activities/notification.activities';

const { sendEmail, sendPushNotification, recordDelivery } =
  proxyActivities<NotificationActivities>({
    // Per-attempt ceiling — if the activity hangs (e.g. HTTP call never resolves),
    // Temporal cancels it after 30 s and the retry policy kicks in.
    startToCloseTimeout: '30 seconds',
    // Total budget across all attempts: 3 retries × ~30 s + backoff ≈ 3 min max.
    // Without this, a workflow can retry indefinitely if maximumAttempts is not set.
    scheduleToCloseTimeout: '3 minutes',
    retry: {
      maximumAttempts: 3,
      initialInterval: '2 seconds',
      backoffCoefficient: 2,
    },
  });

export interface NotificationWorkflowInput {
  userId: string;
  email: string;
  subject: string;
  body: string;
  delayMs?: number;
}

export async function notificationWorkflow(
  input: NotificationWorkflowInput,
): Promise<void> {
  if (input.delayMs) {
    await sleep(input.delayMs);
  }

  await Promise.all([
    sendEmail({ to: input.email, subject: input.subject, body: input.body }),
    sendPushNotification({
      userId: input.userId,
      title: input.subject,
      body: input.body,
    }),
  ]);

  await recordDelivery({
    userId: input.userId,
    sentAt: new Date().toISOString(),
  });
}
