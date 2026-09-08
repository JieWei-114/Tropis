import { log, Context } from '@temporalio/activity';
import * as nodemailer from 'nodemailer';
import { Pool } from 'pg';
import { loadEnv } from '../env';

export interface SendEmailInput {
  to: string;
  subject: string;
  body: string;
}

export interface SendPushInput {
  userId: string;
  title: string;
  body: string;
}

export interface RecordDeliveryInput {
  userId: string;
  sentAt: string;
}

export interface NotificationActivities {
  sendEmail(input: SendEmailInput): Promise<void>;
  sendPushNotification(input: SendPushInput): Promise<void>;
  recordDelivery(input: RecordDeliveryInput): Promise<void>;
}

const env = loadEnv();

// MailHog dev SMTP trap — no auth, no TLS. View mail at http://localhost:8025
const transporter = nodemailer.createTransport({
  host: env.smtpHost,
  port: env.smtpPort,
  secure: false,
});

// Small dedicated pool — activities run short-lived queries only.
const pool = new Pool({
  host: env.pgHost,
  port: env.pgPort,
  user: env.pgUser,
  password: env.pgPassword,
  database: env.pgDatabase,
  max: 5,
});

export const notificationActivities: NotificationActivities = {
  /**
   * Idempotency note: SMTP delivery is inherently at-least-once — if the
   * activity times out after MailHog already accepted the message, Temporal
   * retries and a duplicate email lands in the trap. Acceptable for dev;
   * with a real provider pass a provider-side idempotency/message key.
   */
  async sendEmail({ to, subject, body }: SendEmailInput): Promise<void> {
    log.info('Sending email via MailHog', {
      to,
      subject,
      smtp: `${env.smtpHost}:${env.smtpPort}`,
    });
    await transporter.sendMail({
      from: env.smtpFrom,
      to,
      subject,
      html: body,
    });
  },

  async sendPushNotification({ userId, title }: SendPushInput): Promise<void> {
    // Intentionally a structured log only: a template repo ships no FCM/APNs
    // credentials. Swap for firebase-admin `messaging().send()` (or web-push)
    // in a real deployment — the workflow contract stays the same.
    log.info('Push notification (stub — no FCM in template)', {
      userId,
      title,
    });
  },

  /**
   * Retry-safe: the insert is keyed on (workflow_id, run_id) with
   * ON CONFLICT DO NOTHING, so a retried activity never records a
   * duplicate delivery row. Table created by infra/postgres/init.sql.
   */
  async recordDelivery({ userId, sentAt }: RecordDeliveryInput): Promise<void> {
    const { workflowExecution } = Context.current().info;
    if (!workflowExecution) {
      throw new Error(
        'recordDelivery must run inside a workflow activity context',
      );
    }
    log.info('Recording delivery', { userId, sentAt });
    await pool.query(
      `INSERT INTO notification_deliveries (workflow_id, run_id, user_id, sent_at)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (workflow_id, run_id) DO NOTHING`,
      [workflowExecution.workflowId, workflowExecution.runId, userId, sentAt],
    );
  },
};
